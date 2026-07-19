import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentKBHit, DEFAULT_AGENTKB_CWD, DEFAULT_AGENTKB_PYTHON, kbSearch } from "./agentkb.ts";
import { BudgetTracker } from "./budget.ts";
import { capText, type InvestigatorEvent, runInvestigation } from "./investigator.ts";
import { createRunLogger, DEFAULT_LOG_DIR, loggingOnEvent, type RlmLogger } from "./logging.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl } from "./repl.ts";
import { createRpcHandlers, type NestedEvent } from "./rpc.ts";

const DEFAULT_INVESTIGATOR_PROVIDER = "azure-foundry";
const DEFAULT_INVESTIGATOR_MODEL = "Kimi-K2.6";
const DEFAULT_ANALYST_PROVIDER = "azure-foundry";
const DEFAULT_ANALYST_MODEL = "gpt-5.4-nano";
const DEFAULT_MAX_LLM_CALLS = 100;
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_BUDGET_USD = 0.5;
const DEFAULT_K = 5;
const DEFAULT_SCOPE = "wiki";
const OUTPUT_CAP_CHARS = 10_000;
const UPDATE_CAP_CHARS = 20_000;

/** Per-entry and total caps bound details growth in the session JSONL. */
export const TIMELINE_ENTRY_CAP_CHARS = 2_000;
export const TIMELINE_MAX_ENTRIES = 200;

const CALL_PROMPT_PREVIEW_CHARS = 80;
const NESTED_PROMPT_PREVIEW_CHARS = 120;
const PARTIAL_TIMELINE_TAIL_ENTRIES = 8;
const COLLAPSED_ANSWER_LINES = 10;

const RlmQueryParams = Type.Object({
	prompt: Type.String({
		description:
			"The question to investigate — a knowledge-base/wiki question or an aggregate/cross-source analysis that requires reading many documents or files.",
	}),
	scope: Type.Optional(
		Type.String({
			description: `Initial kb_search scope. Default "${DEFAULT_SCOPE}".`,
		}),
	),
	k: Type.Optional(
		Type.Number({
			description: `Number of hits for the initial kb_search. Default ${DEFAULT_K}.`,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description: `Maximum investigator turns. Default ${DEFAULT_MAX_TURNS}.`,
		}),
	),
	maxDepth: Type.Optional(
		Type.Number({
			description: `Maximum rlm_query recursion depth; 0 disables recursion (every rlm_query downgrades to llm_query). Default ${DEFAULT_MAX_DEPTH}.`,
		}),
	),
	maxBudget: Type.Optional(
		Type.Number({
			description: `Maximum model spend in USD for this investigation. Default ${DEFAULT_MAX_BUDGET_USD}.`,
		}),
	),
	investigatorProvider: Type.Optional(
		Type.String({
			description: `Provider id for the investigator model. Default "${DEFAULT_INVESTIGATOR_PROVIDER}".`,
		}),
	),
	investigatorModel: Type.Optional(
		Type.String({
			description: `Model id for the investigator. Default "${DEFAULT_INVESTIGATOR_MODEL}".`,
		}),
	),
	analystProvider: Type.Optional(
		Type.String({
			description: `Provider id for the analyst model used by llm_query. Default "${DEFAULT_ANALYST_PROVIDER}".`,
		}),
	),
	analystModel: Type.Optional(
		Type.String({
			description: `Model id for the analyst used by llm_query. Default "${DEFAULT_ANALYST_MODEL}".`,
		}),
	),
	maxLlmCalls: Type.Optional(
		Type.Number({
			description: `Call-count backstop for the shared budget (covers analyst calls and nested-investigation turns; the top-level investigator's turns get extra headroom). Default ${DEFAULT_MAX_LLM_CALLS}.`,
		}),
	),
	pythonPath: Type.Optional(
		Type.String({
			description: "Optional Python binary path for the REPL host. Defaults to the agentkb venv.",
		}),
	),
	agentkbPythonPath: Type.Optional(
		Type.String({
			description: "Optional Python binary path used to invoke agentkb. Defaults to the agentkb venv.",
		}),
	),
	agentkbCwd: Type.Optional(
		Type.String({
			description: "Optional working directory for agentkb invocations.",
		}),
	),
	restrictReadRoot: Type.Optional(
		Type.String({
			description: "Optional root directory kb_read is restricted to. Defaults to the agentkb cwd.",
		}),
	),
	logDir: Type.Optional(
		Type.String({
			description: "Directory for NDJSON run logs. Default ~/.pi/rlm-logs.",
		}),
	),
});

type RlmQueryArgs = Static<typeof RlmQueryParams>;

export interface TimelineEntry {
	kind: "note" | "turn" | "assistant" | "exec" | "nested_start" | "nested_end";
	turn?: number;
	/** Set on nested_* entries. */
	depth?: number;
	/** Capped at TIMELINE_ENTRY_CAP_CHARS. */
	text: string;
}

export interface RlmQueryDetails {
	stopReason?: string;
	turns: number;
	costUsd?: number;
	modelCalls?: number;
	contextHits: number;
	nestedRuns?: number;
	runId?: string;
	logPath?: string;
	timeline: TimelineEntry[];
}

export interface TimelineRecorder {
	/** Investigator-event adapter for the top-level run. */
	onEvent: (ev: InvestigatorEvent) => void;
	/** Nested-run lifecycle adapter. */
	onNested: (ev: NestedEvent) => void;
	/** Free-form note entry (degradations, warnings). */
	note: (text: string) => void;
	/** Snapshot including the dropped-entries marker, capped at TIMELINE_MAX_ENTRIES. */
	entries: () => TimelineEntry[];
	lastTurn: () => number;
}

/**
 * Records the live investigation timeline. Entry texts are capped at
 * TIMELINE_ENTRY_CAP_CHARS; once more than TIMELINE_MAX_ENTRIES accumulate,
 * the oldest are dropped and entries() prepends one dropped-note marker.
 */
export function createTimelineRecorder(onChange?: () => void): TimelineRecorder {
	const timeline: TimelineEntry[] = [];
	let dropped = 0;
	let lastTurn = 0;
	const maxReal = () => (dropped > 0 ? TIMELINE_MAX_ENTRIES - 1 : TIMELINE_MAX_ENTRIES);
	const push = (entry: TimelineEntry) => {
		timeline.push({ ...entry, text: capText(entry.text, TIMELINE_ENTRY_CAP_CHARS) });
		while (timeline.length > maxReal()) {
			timeline.shift();
			dropped++;
		}
		onChange?.();
	};
	return {
		onEvent(ev) {
			if (ev.type === "turn_start") {
				lastTurn = ev.turn;
				push({ kind: "turn", turn: ev.turn, text: `--- turn ${ev.turn} ---` });
			} else if (ev.type === "assistant_text") {
				lastTurn = ev.turn;
				push({ kind: "assistant", turn: ev.turn, text: ev.text ?? "" });
			} else if (ev.type === "exec_result") {
				lastTurn = ev.turn;
				push({ kind: "exec", turn: ev.turn, text: ev.text ?? "" });
			}
			// code_block is already part of the assistant text; done has no text.
		},
		onNested(ev) {
			// Plain head slice, not capText: head+tail capping would inject
			// newlines into what should be a single timeline line.
			const promptPreview =
				ev.prompt.length > NESTED_PROMPT_PREVIEW_CHARS
					? `${ev.prompt.slice(0, NESTED_PROMPT_PREVIEW_CHARS)}...`
					: ev.prompt;
			push(
				ev.phase === "start"
					? {
							kind: "nested_start",
							depth: ev.depth,
							text: `[depth ${ev.depth} rlm_query started: ${promptPreview}]`,
						}
					: {
							kind: "nested_end",
							depth: ev.depth,
							text: `[depth ${ev.depth} rlm_query finished: ${ev.stopReason}, ${ev.turns} turns]`,
						},
			);
		},
		note(text) {
			push({ kind: "note", text });
		},
		entries: () =>
			dropped > 0
				? [{ kind: "note", text: `[... ${dropped} earlier entries dropped]` }, ...timeline]
				: [...timeline],
		lastTurn: () => lastTurn,
	};
}

/** Plain-text rendering of the timeline; matches the pre-Phase-6 transcript format. */
export function timelineToText(entries: TimelineEntry[]): string {
	return entries.map((e) => e.text).join("\n\n");
}

/** One-line run summary, e.g. "final · 5 turns · 23 calls · $0.0841 · 2 nested · 5 ctx hits". */
export function formatRunStats(details: RlmQueryDetails): string {
	const parts: string[] = [];
	if (details.stopReason) parts.push(details.stopReason);
	parts.push(`${details.turns} turn${details.turns === 1 ? "" : "s"}`);
	if (details.modelCalls !== undefined) parts.push(`${details.modelCalls} calls`);
	if (details.costUsd !== undefined) parts.push(`$${details.costUsd.toFixed(4)}`);
	if (details.nestedRuns) parts.push(`${details.nestedRuns} nested`);
	parts.push(`${details.contextHits} ctx hit${details.contextHits === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

/**
 * Tail-weighted capping for the live onUpdate transcript: unlike observation
 * capping (head-weighted, see capText), the newest activity is at the end and
 * is what live progress should show.
 */
function capTranscript(text: string, cap: number): string {
	if (text.length <= cap) return text;
	return `[... ${text.length - cap} earlier chars omitted ...]\n${text.slice(-cap)}`;
}

export function renderRlmCall(args: RlmQueryArgs, theme: Theme): Component {
	const prompt = args.prompt ?? "...";
	const promptPreview =
		prompt.length > CALL_PROMPT_PREVIEW_CHARS ? `${prompt.slice(0, CALL_PROMPT_PREVIEW_CHARS)}...` : prompt;
	let text = theme.fg("toolTitle", theme.bold("rlm_query ")) + theme.fg("accent", promptPreview);

	const nonDefaults: string[] = [];
	if (args.scope !== undefined && args.scope !== DEFAULT_SCOPE) nonDefaults.push(`scope=${args.scope}`);
	if (args.k !== undefined && args.k !== DEFAULT_K) nonDefaults.push(`k=${args.k}`);
	if (args.maxTurns !== undefined && args.maxTurns !== DEFAULT_MAX_TURNS)
		nonDefaults.push(`maxTurns=${args.maxTurns}`);
	if (args.maxDepth !== undefined && args.maxDepth !== DEFAULT_MAX_DEPTH)
		nonDefaults.push(`maxDepth=${args.maxDepth}`);
	if (args.maxBudget !== undefined && args.maxBudget !== DEFAULT_MAX_BUDGET_USD) {
		nonDefaults.push(`maxBudget=$${args.maxBudget}`);
	}
	const investigator = `${args.investigatorProvider ?? DEFAULT_INVESTIGATOR_PROVIDER}/${args.investigatorModel ?? DEFAULT_INVESTIGATOR_MODEL}`;
	if (investigator !== `${DEFAULT_INVESTIGATOR_PROVIDER}/${DEFAULT_INVESTIGATOR_MODEL}`) {
		nonDefaults.push(`investigator=${investigator}`);
	}
	const analyst = `${args.analystProvider ?? DEFAULT_ANALYST_PROVIDER}/${args.analystModel ?? DEFAULT_ANALYST_MODEL}`;
	if (analyst !== `${DEFAULT_ANALYST_PROVIDER}/${DEFAULT_ANALYST_MODEL}`) {
		nonDefaults.push(`analyst=${analyst}`);
	}
	if (nonDefaults.length > 0) {
		text += `\n  ${theme.fg("muted", `[${nonDefaults.join(" ")}]`)}`;
	}
	return new Text(text, 0, 0);
}

function statusIcon(stopReason: string | undefined, theme: Theme): string {
	if (stopReason === "final") return theme.fg("success", "✓");
	if (stopReason === "no_code" || stopReason === "max_turns" || stopReason === "budget") {
		return theme.fg("warning", "◐");
	}
	return theme.fg("error", "✗"); // error / aborted / unknown
}

function renderTimelineEntry(entry: TimelineEntry, theme: Theme): string {
	switch (entry.kind) {
		case "turn":
		case "note":
			return theme.fg("muted", entry.text);
		case "assistant":
			return theme.fg("toolOutput", entry.text);
		case "exec":
			return theme.fg("dim", entry.text);
		case "nested_start":
		case "nested_end":
			return "  ".repeat(Math.max(1, entry.depth ?? 1)) + theme.fg("accent", entry.text);
	}
}

export function renderRlmResult(
	result: AgentToolResult<RlmQueryDetails | undefined>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const details = result.details;
	const first = result.content[0];
	const answer = first?.type === "text" ? first.text : "";

	// Old sessions / degenerate results without a timeline: plain content.
	if (!details?.timeline) {
		return new Text(answer || "(no output)", 0, 0);
	}

	if (options.isPartial) {
		const statsParts = [`turn ${details.turns}`];
		if (details.modelCalls !== undefined) statsParts.push(`${details.modelCalls} calls`);
		if (details.nestedRuns) statsParts.push(`${details.nestedRuns} nested`);
		let text =
			`${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("investigating…"))} ` +
			theme.fg("accent", statsParts.join(" · "));
		const tail = details.timeline.slice(-PARTIAL_TIMELINE_TAIL_ENTRIES);
		for (const entry of tail) {
			text += `\n${renderTimelineEntry(entry, theme)}`;
		}
		return new Text(text, 0, 0);
	}

	const header =
		`${statusIcon(details.stopReason, theme)} ${theme.fg("toolTitle", theme.bold("rlm_query "))}` +
		theme.fg("accent", formatRunStats(details));

	if (!options.expanded) {
		const lines = answer.split("\n");
		const head = lines.slice(0, COLLAPSED_ANSWER_LINES).join("\n");
		let text = header;
		if (head.trim()) text += `\n${theme.fg("toolOutput", head)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Investigation ───"), 0, 0));
	for (const entry of details.timeline) {
		container.addChild(new Text(renderTimelineEntry(entry, theme), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
	container.addChild(new Markdown(answer.trim() || "(no answer)", 0, 0, getMarkdownTheme()));
	if (details.runId && details.logPath) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `run ${details.runId} · log: ${details.logPath}`), 0, 0));
	}
	return container;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rlm_query",
		label: "RLM Query",
		description:
			"Answer a question by iterative Python-REPL investigation (RLM). The investigator has knowledge-base " +
			"builtins (kb_search/kb_read), the full Python stdlib, and a smaller analyst LLM to delegate to — " +
			"including batched fan-out over many documents. Use it when research requires reading many sources to " +
			"produce a synthesized answer: knowledge-base/wiki questions, aggregate or cross-file analysis. For a " +
			"single grep or file read, use the built-in tools instead.",
		promptSnippet: "Multi-source KB/wiki and aggregate analysis via an isolated REPL investigation",
		promptGuidelines: [
			"Use rlm_query when a question requires reading or searching many sources to produce a synthesized answer — knowledge-base/wiki questions, aggregate or cross-file analysis ('which of these files mentions X', 'compare N docs', 'summarize the codebase approach to Y'). It runs in an isolated Python REPL with KB builtins, full stdlib, and analyst-LLM fan-out, returning only the final answer. For a single grep, a one-shot file read, or finding where something is defined, use the built-in tools — rlm_query adds overhead and costs real model budget.",
			"Give rlm_query one self-contained question with all needed constraints; it cannot see this conversation. Its REPL runs in your working directory, so repo-relative paths work.",
			"rlm_query spends real model budget (default $0.50 cap per call); prefer one well-scoped question over many small ones.",
		],
		parameters: RlmQueryParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const provider = params.investigatorProvider ?? DEFAULT_INVESTIGATOR_PROVIDER;
			const modelId = params.investigatorModel ?? DEFAULT_INVESTIGATOR_MODEL;
			const analystProvider = params.analystProvider ?? DEFAULT_ANALYST_PROVIDER;
			const analystModelId = params.analystModel ?? DEFAULT_ANALYST_MODEL;
			const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
			const maxDepth = params.maxDepth ?? DEFAULT_MAX_DEPTH;
			const maxBudgetUsd = params.maxBudget ?? DEFAULT_MAX_BUDGET_USD;
			const maxLlmCalls = params.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
			const k = params.k ?? DEFAULT_K;
			const scope = params.scope ?? DEFAULT_SCOPE;

			// Caller errors fail fast; only environmental failures (agentkb missing,
			// search exiting non-zero) degrade to an empty context below.
			if (!Number.isInteger(k) || k < 1 || k > 50) {
				throw new Error(`rlm_query: k must be an integer between 1 and 50, got ${k}`);
			}
			if (!Number.isInteger(maxTurns) || maxTurns < 1) {
				throw new Error(`rlm_query: maxTurns must be a positive integer, got ${maxTurns}`);
			}
			if (!Number.isInteger(maxDepth) || maxDepth < 0) {
				throw new Error(`rlm_query: maxDepth must be an integer >= 0, got ${maxDepth}`);
			}
			if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
				throw new Error(`rlm_query: maxBudget must be a positive USD amount, got ${maxBudgetUsd}`);
			}
			if (!Number.isInteger(maxLlmCalls) || maxLlmCalls < 1) {
				throw new Error(`rlm_query: maxLlmCalls must be a positive integer, got ${maxLlmCalls}`);
			}

			const model = ctx.modelRegistry.find(provider, modelId);
			if (!model) {
				throw new Error(
					`rlm_query: model "${provider}/${modelId}" not found in the runtime model registry. ` +
						`Check ~/.pi/agent/models.json or override investigatorProvider/investigatorModel.`,
				);
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(`rlm_query: auth resolution failed for "${provider}/${modelId}": ${auth.error}`);
			}

			// Analyst resolution is fail-fast too: a half-working REPL whose
			// llm_query always errors wastes investigator turns discovering it.
			const analystModel = ctx.modelRegistry.find(analystProvider, analystModelId);
			if (!analystModel) {
				throw new Error(
					`rlm_query: model "${analystProvider}/${analystModelId}" not found in the runtime model registry. ` +
						`Check ~/.pi/agent/models.json or override analystProvider/analystModel.`,
				);
			}
			const analystAuth = await ctx.modelRegistry.getApiKeyAndHeaders(analystModel);
			if (!analystAuth.ok) {
				throw new Error(
					`rlm_query: auth resolution failed for "${analystProvider}/${analystModelId}": ${analystAuth.error}`,
				);
			}

			const agentkbOptions = {
				pythonPath: params.agentkbPythonPath ?? DEFAULT_AGENTKB_PYTHON,
				agentkbCwd: params.agentkbCwd ?? DEFAULT_AGENTKB_CWD,
				restrictReadRoot: params.restrictReadRoot,
				signal,
			};

			const stats = { nestedRuns: 0 };
			let contextHits: AgentKBHit[] = [];
			let logger: RlmLogger | undefined;

			const recorder = createTimelineRecorder(() => pushUpdate());
			const makeDetails = (extra?: Partial<RlmQueryDetails>): RlmQueryDetails => ({
				turns: recorder.lastTurn(),
				contextHits: contextHits.length,
				nestedRuns: stats.nestedRuns,
				runId: logger?.runId,
				logPath: logger?.logPath,
				timeline: recorder.entries(),
				...extra,
			});
			const pushUpdate = () => {
				onUpdate?.({
					content: [{ type: "text", text: capTranscript(timelineToText(recorder.entries()), UPDATE_CAP_CHARS) }],
					details: makeDetails(),
				});
			};

			// Logging is always on and best-effort: setup failure degrades to a
			// logger-less run with one timeline note, mirroring the initial
			// kb_search degradation below. Mid-run write failures disable the
			// logger, which warns through the same note path.
			try {
				logger = await createRunLogger(params.logDir ?? DEFAULT_LOG_DIR, (msg) => recorder.note(`[${msg}]`));
			} catch (err) {
				recorder.note(`[run logging disabled: ${err instanceof Error ? err.message : String(err)}]`);
			}

			// Initial context search. Failure (no agentkb on this machine, non-zero
			// exit, ...) is not fatal: the model is told the search failed and may
			// retry kb_search itself or answer from reasoning alone.
			let contextNote: string | undefined;
			try {
				contextHits = await kbSearch(agentkbOptions, params.prompt, k, scope);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				contextNote = `initial kb_search failed: ${capText(message, 500)}`;
			}
			if (contextNote) {
				recorder.note(`[${contextNote} — running without preloaded context]`);
			}

			const systemPrompt = buildSystemPrompt({
				contextCount: contextHits.length,
				contextNote,
				canRecurse: maxDepth > 0,
				maxTurns,
				outputCapChars: OUTPUT_CAP_CHARS,
			});

			// One shared pool for investigator + analyst spend across the whole
			// recursion tree. The call cap covers the pool (including nested-
			// investigation turns), so it leaves headroom for the investigator's
			// own turns.
			const budget = new BudgetTracker(maxBudgetUsd, maxLlmCalls + maxTurns);

			// RLM_PYTHON is the same override the test scripts honor, for machines
			// without the agentkb venv. Shared by the top-level and nested REPLs.
			const replPythonPath = params.pythonPath ?? process.env.RLM_PYTHON ?? DEFAULT_AGENTKB_PYTHON;

			logger?.log({
				inv: "root",
				event: "run_start",
				question: params.prompt,
				investigator: `${provider}/${modelId}`,
				analyst: `${analystProvider}/${analystModelId}`,
				maxTurns,
				maxDepth,
				maxBudgetUsd,
				maxLlmCalls,
				k,
				scope,
				contextHits: contextHits.length,
				contextNote,
			});

			// run_end must bracket the file on every exit path; the guard keeps the
			// success path and the catch from both logging it.
			let runEnded = false;
			const logRunEnd = (stopReason: string, turns: number, answer?: string) => {
				if (runEnded) return;
				runEnded = true;
				logger?.log({
					inv: "root",
					event: "run_end",
					stopReason,
					turns,
					costUsd: budget.spentUsd,
					modelCalls: budget.callCount,
					nestedRuns: stats.nestedRuns,
					answer,
				});
			};

			const repl = new PythonRepl({ pythonPath: replPythonPath, signal });
			repl.setRpcHandlers(
				createRpcHandlers(
					agentkbOptions,
					{
						model: analystModel,
						apiKey: analystAuth.apiKey,
						headers: analystAuth.headers,
						budget,
						signal,
					},
					{
						depth: 0,
						maxDepth,
						replPythonPath,
						maxTurns,
						outputCapChars: OUTPUT_CAP_CHARS,
						k,
						scope,
						stats,
						onNested: recorder.onNested,
						inv: "root",
						logger,
					},
				),
			);

			try {
				await repl.ready();
				await repl.setVar("context", contextHits);

				const result = await runInvestigation({
					question: params.prompt,
					systemPrompt,
					repl,
					model,
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTurns,
					budget,
					outputCapChars: OUTPUT_CAP_CHARS,
					signal,
					onEvent: loggingOnEvent(logger, "root", recorder.onEvent),
				});

				logRunEnd(result.stopReason, result.turns, result.answer);
				const answer = result.stopReason === "error" ? `[Investigation failed]\n${result.answer}` : result.answer;
				return {
					content: [{ type: "text", text: answer }],
					details: makeDetails({
						stopReason: result.stopReason,
						turns: result.turns,
						costUsd: result.costUsd,
						modelCalls: budget.callCount,
					}),
				};
			} catch (err) {
				logRunEnd(signal?.aborted ? "aborted" : "error", recorder.lastTurn());
				throw err;
			} finally {
				await logger?.close();
				await repl.close();
			}
		},

		renderCall(args, theme) {
			return renderRlmCall(args, theme);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			// TDetails is unknown in the render callback; details are validated
			// structurally (timeline guard) inside renderRlmResult.
			return renderRlmResult(result as AgentToolResult<RlmQueryDetails | undefined>, { expanded, isPartial }, theme);
		},
	});
}
