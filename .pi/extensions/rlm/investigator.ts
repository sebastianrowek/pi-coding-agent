import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import type { BudgetTracker } from "./budget.ts";
import type { ExecResult, PythonRepl } from "./repl.ts";

export type CompleteFn = typeof complete;

export interface InvestigatorEvent {
	type: "turn_start" | "assistant_text" | "code_block" | "exec_result" | "done";
	turn: number;
	/** Prose / code / capped output, depending on type. */
	text?: string;
}

export interface InvestigationOptions {
	question: string;
	systemPrompt: string;
	/** Ready REPL with RPC handlers already set. */
	repl: PythonRepl;
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	maxTurns: number;
	/** Shared pool charged by the investigator's own calls and every analyst call. */
	budget: BudgetTracker;
	outputCapChars: number;
	signal?: AbortSignal;
	onEvent?: (ev: InvestigatorEvent) => void;
	/** Injectable for tests; defaults to the real complete() from pi-ai. */
	completeFn?: CompleteFn;
}

export interface InvestigationResult {
	answer: string;
	stopReason: "final" | "no_code" | "max_turns" | "budget" | "error" | "aborted";
	/**
	 * Number of model calls made (or attempted). A turn that exits before its
	 * model call (budget/abort check at the top of the loop) does not count.
	 */
	turns: number;
	/**
	 * Total spend of the shared budget pool (budget.spentUsd), not just this
	 * run's own calls — with one pool the meaningful number is total spend.
	 * Phase 5 inherits the semantics: nested results report tree-total spend.
	 */
	costUsd: number;
}

const FENCE_RE = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/g;

/** Returns the last fenced Python block, or null if there is none or it is empty. */
export function extractLastCodeBlock(text: string): string | null {
	let last: string | null = null;
	for (const match of text.matchAll(FENCE_RE)) {
		last = match[1] ?? null;
	}
	if (last === null || !last.trim()) return null;
	return last;
}

/** Head+tail capping: tracebacks and loop summaries land at the end. */
export function capText(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const head = Math.floor(cap * 0.7);
	const tail = Math.floor(cap * 0.2);
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n... [output truncated: ${omitted} chars omitted] ...\n${text.slice(text.length - tail)}`;
}

function buildObservation(result: ExecResult, outputCapChars: number): string {
	const parts: string[] = [];
	if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	if (result.error) parts.push(`error:\n${result.error}`);
	if (parts.length === 0) return "(no output — use print() to see values)";
	return capText(parts.join("\n\n"), outputCapChars);
}

function bestEffortAnswer(why: string, lastAssistantText: string): string {
	return `[Investigation stopped: ${why} without FINAL(). Last reasoning state:]\n${lastAssistantText}`;
}

/** Concatenated TextContent parts of an assistant reply (thinking blocks ignored). */
export function assistantText(msg: AssistantMessage): string {
	return msg.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export async function runInvestigation(opts: InvestigationOptions): Promise<InvestigationResult> {
	const completeFn = opts.completeFn ?? complete;
	const messages: Message[] = [{ role: "user", content: opts.question, timestamp: Date.now() }];
	const budget = opts.budget;
	let lastAssistantText = "";

	const emit = (ev: InvestigatorEvent) => opts.onEvent?.(ev);
	const finish = (result: InvestigationResult): InvestigationResult => {
		emit({ type: "done", turn: result.turns });
		return result;
	};

	for (let turn = 1; turn <= opts.maxTurns; turn++) {
		if (opts.signal?.aborted) {
			return finish({
				answer: "Investigation aborted.",
				stopReason: "aborted",
				turns: turn - 1,
				costUsd: budget.spentUsd,
			});
		}
		if (budget.exhausted()) {
			// Either dimension can trip: USD spend or the call-count backstop.
			const why = `budget exhausted ($${budget.spentUsd.toFixed(2)} of $${budget.maxUsd.toFixed(2)}, ${budget.callCount} of ${budget.maxCalls} calls)`;
			return finish({
				answer: bestEffortAnswer(why, lastAssistantText),
				stopReason: "budget",
				turns: turn - 1,
				costUsd: budget.spentUsd,
			});
		}

		emit({ type: "turn_start", turn });

		let msg: AssistantMessage;
		try {
			msg = await completeFn(
				opts.model,
				{ systemPrompt: opts.systemPrompt, messages },
				{ apiKey: opts.apiKey, headers: opts.headers, signal: opts.signal },
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.signal?.aborted) {
				return finish({
					answer: "Investigation aborted.",
					stopReason: "aborted",
					turns: turn,
					costUsd: budget.spentUsd,
				});
			}
			return finish({
				answer: `Model call failed: ${message}`,
				stopReason: "error",
				turns: turn,
				costUsd: budget.spentUsd,
			});
		}

		messages.push(msg);
		// Charge on stop/length only: an "error" reply made no spend the API
		// reported reliably; an "aborted" one is the user's Esc.
		if (msg.stopReason === "stop" || msg.stopReason === "length") {
			budget.add(msg.usage.cost.total);
		}

		if (msg.stopReason === "aborted") {
			return finish({
				answer: "Investigation aborted.",
				stopReason: "aborted",
				turns: turn,
				costUsd: budget.spentUsd,
			});
		}
		if (msg.stopReason === "error") {
			return finish({
				answer: `Model error: ${msg.errorMessage ?? "unknown error"}`,
				stopReason: "error",
				turns: turn,
				costUsd: budget.spentUsd,
			});
		}

		const text = assistantText(msg);
		lastAssistantText = text;
		emit({ type: "assistant_text", turn, text });

		if (msg.stopReason === "length") {
			// The reply was cut off by the output token limit; even a complete-looking
			// fence may be missing its tail. Never execute it — nudge and retry.
			// Note: if this charge trips the budget, the retry message pushed below is
			// never seen by a model call (the next iteration exits on budget.exhausted()
			// before complete()). It stays in the history but is harmless dead weight.
			messages.push({
				role: "user",
				content:
					"Your previous reply was cut off by the output token limit. " +
					"Resend the complete fenced ```python block; keep it shorter.",
				timestamp: Date.now(),
			});
			continue;
		}

		const code = extractLastCodeBlock(text);
		if (code === null) {
			return finish({ answer: text, stopReason: "no_code", turns: turn, costUsd: budget.spentUsd });
		}
		emit({ type: "code_block", turn, text: code });

		let result: ExecResult;
		try {
			result = await opts.repl.exec(code);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (opts.signal?.aborted) {
				return finish({
					answer: "Investigation aborted.",
					stopReason: "aborted",
					turns: turn,
					costUsd: budget.spentUsd,
				});
			}
			return finish({
				answer: `REPL execution failed: ${message}`,
				stopReason: "error",
				turns: turn,
				costUsd: budget.spentUsd,
			});
		}

		const observation = buildObservation(result, opts.outputCapChars);
		emit({ type: "exec_result", turn, text: observation });

		if (result.final !== null && result.final !== undefined) {
			return finish({ answer: result.final, stopReason: "final", turns: turn, costUsd: budget.spentUsd });
		}

		messages.push({ role: "user", content: observation, timestamp: Date.now() });
	}

	return finish({
		answer: bestEffortAnswer("turn limit reached", lastAssistantText),
		stopReason: "max_turns",
		turns: opts.maxTurns,
		costUsd: budget.spentUsd,
	});
}
