import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import { type AgentKBOptions, kbRead, kbSearch } from "./agentkb.ts";
import type { BudgetTracker } from "./budget.ts";
import { assistantText, type CompleteFn, capText, runInvestigation } from "./investigator.ts";
import { loggingOnEvent, preview, type RlmLogger } from "./logging.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl, type RpcHandler, type RpcHandlers } from "./repl.ts";

export interface LlmOptions {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	/** Shared with the investigator loop; analyst calls spend the same pool. */
	budget: BudgetTracker;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to the real complete() from pi-ai. */
	completeFn?: CompleteFn;
}

export interface NestedEvent {
	phase: "start" | "end";
	depth: number;
	prompt: string;
	stopReason?: string;
	turns?: number;
}

export interface RlmRecursionOptions {
	/** Depth of the investigation that owns this handler set; 0 = top level. */
	depth: number;
	/** An rlm_query issued at depth >= maxDepth downgrades to llm_query. */
	maxDepth: number;
	/** Python binary for nested REPL hosts (same resolution as the top level). */
	replPythonPath: string;
	/** Per-child turn cap; index.ts passes the tool's maxTurns through. */
	maxTurns: number;
	outputCapChars: number;
	/** Defaults for a child's initial context search. */
	k: number;
	scope: string;
	/** Injectable for tests; defaults to kbSearch from agentkb.ts. */
	kbSearchFn?: typeof kbSearch;
	/**
	 * Child-investigator complete(); separate from llm.completeFn so tests can
	 * script the child investigator and the analyst independently. Defaults to
	 * the real complete().
	 */
	completeFn?: CompleteFn;
	/** Counts real (non-downgraded) nested runs across the whole tree. */
	stats?: { nestedRuns: number };
	/** Lifecycle notifications for the parent transcript. */
	onNested?: (ev: NestedEvent) => void;
	/**
	 * Investigation path id of the handler-set owner ("root", "root.1", ...).
	 * Default "root". Optional is the semantically right shape: tests and
	 * log-disabled runs legitimately run without ids beyond the default.
	 */
	inv?: string;
	/** Shared tree logger; absent in tests and when log setup failed. */
	logger?: RlmLogger;
}

const LLM_BATCH_CONCURRENCY = 16;
const MAX_BATCH_PROMPTS = 100;
const LLM_RPC_TIMEOUT_MS = 300_000;
const LLM_BATCH_RPC_TIMEOUT_MS = 900_000;
const RLM_BATCH_CONCURRENCY = 4;
const MAX_RLM_BATCH_PROMPTS = 20;
// A nested run is bounded by maxTurns model calls plus REPL work, each of which
// can take minutes; 20 min single is headroom, not an expectation. The batch
// timeout covers 20 queued runs through a 4-wide window.
const RLM_RPC_TIMEOUT_MS = 1_200_000;
const RLM_BATCH_RPC_TIMEOUT_MS = 3_600_000;
const DOWNGRADE_CONTEXT_CAP_CHARS = 8_000;

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name}: args must be an object`);
	}
	return value as Record<string, unknown>;
}

/**
 * Maps over items with at most `limit` concurrent calls. `limit` must be >= 1;
 * passing 0 is clamped to 1 (sequential). Items are processed in index order;
 * results are returned in input order.
 */
export async function mapWithConcurrencyLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	// Math.max(1, limit) guards against a limit of 0 producing a sparse-undefined
	// result array instead of running items sequentially.
	const workerCount = Math.min(Math.max(1, limit), items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function runAnalystCall(llm: LlmOptions, prompt: string): Promise<string> {
	// Check before launch, charge after completion: an in-flight call may
	// overshoot maxUsd, but a fan-out stops admitting new calls once the pool
	// is dry (each batched sibling re-checks right before its own launch).
	if (llm.budget.exhausted()) {
		throw new Error(
			`llm_query: budget exhausted ($${llm.budget.spentUsd.toFixed(2)} of $${llm.budget.maxUsd.toFixed(2)}, ${llm.budget.callCount} calls)`,
		);
	}

	const completeFn = llm.completeFn ?? complete;
	let msg: AssistantMessage;
	try {
		msg = await completeFn(
			llm.model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ apiKey: llm.apiKey, headers: llm.headers, signal: llm.signal },
		);
	} catch (err) {
		throw new Error(`llm_query: model call failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Charge on stop/length only — an "error" reply made no spend the API
	// reported reliably; "aborted" is the user's Esc.
	if (msg.stopReason === "error") {
		throw new Error(`llm_query: model error: ${msg.errorMessage ?? "unknown error"}`);
	}
	if (msg.stopReason === "aborted") {
		throw new Error("llm_query aborted");
	}
	llm.budget.add(msg.usage.cost.total);
	return assistantText(msg);
}

/**
 * At the depth limit, rlm_query becomes one analyst call. The parent passed
 * context deliberately, so fold it into the prompt rather than dropping it.
 */
function composeDowngradePrompt(prompt: string, context: unknown): string {
	if (context === null || context === undefined) return prompt;
	// context arrived as parsed JSON, so JSON.stringify cannot fail here.
	return `Context (from the parent investigation):\n${capText(JSON.stringify(context), DOWNGRADE_CONTEXT_CAP_CHARS)}\n\nQuestion: ${prompt}`;
}

async function runNestedRlmQuery(
	kb: AgentKBOptions,
	llm: LlmOptions,
	rlm: RlmRecursionOptions,
	prompt: string,
	context: unknown,
	nextChildInv: () => string,
): Promise<string> {
	const inv = rlm.inv ?? "root";

	// Checked before the depth check so an exhausted pool never spawns anything.
	if (llm.budget.exhausted()) {
		throw new Error(
			`rlm_query: budget exhausted ($${llm.budget.spentUsd.toFixed(2)} of $${llm.budget.maxUsd.toFixed(2)}, ${llm.budget.callCount} calls)`,
		);
	}

	// Silent downgrade at the depth limit; with maxDepth 0 every rlm_query
	// downgrades, which makes the param double as a recursion kill switch. The
	// downgrade event explains why no child run follows (the analyst call itself
	// is already visible as the parent's rpc event for rlm_query).
	if (rlm.depth >= rlm.maxDepth) {
		rlm.logger?.log({ inv, event: "downgrade", depth: rlm.depth, prompt });
		return runAnalystCall(llm, composeDowngradePrompt(prompt, context));
	}

	// Allocated here (synchronously after the downgrade check) so sibling ids
	// reflect call order and downgrades never consume an id.
	const childInv = nextChildInv();

	// Child context: a parent-provided list wins; otherwise a fresh search for
	// the child prompt. Search failure degrades to empty context + prompt note,
	// mirroring the top level in index.ts.
	let hits: unknown[];
	let contextNote: string | undefined;
	let contextFromParent = false;
	if (Array.isArray(context)) {
		hits = context;
		contextFromParent = true;
	} else {
		try {
			hits = await (rlm.kbSearchFn ?? kbSearch)(kb, prompt, rlm.k, rlm.scope);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			hits = [];
			contextNote = `initial kb_search failed: ${capText(message, 500)}`;
		}
	}

	const childDepth = rlm.depth + 1;
	if (rlm.stats) rlm.stats.nestedRuns += 1;
	rlm.logger?.log({ inv, event: "nested_start", child: childInv, depth: childDepth, prompt });
	rlm.onNested?.({ phase: "start", depth: childDepth, prompt });
	let ended = false;
	const emitEnd = (stopReason: string, turns: number) => {
		if (ended) return;
		ended = true;
		rlm.logger?.log({ inv, event: "nested_end", child: childInv, stopReason, turns });
		rlm.onNested?.({ phase: "end", depth: childDepth, prompt, stopReason, turns });
	};

	const repl = new PythonRepl({ pythonPath: rlm.replPythonPath, signal: llm.signal });
	repl.setRpcHandlers(createRpcHandlers(kb, llm, { ...rlm, depth: childDepth, inv: childInv }));
	try {
		await repl.ready();
		await repl.setVar("context", hits);

		// The child investigator is the analyst model (locked in PLAN.md);
		// budget and signal flow through llm unchanged — one shared pool.
		// Child turn detail goes to the log only (under childInv): concurrent
		// batched children would interleave illegibly in a flat live transcript.
		const result = await runInvestigation({
			question: prompt,
			systemPrompt: buildSystemPrompt({
				contextCount: hits.length,
				contextNote,
				contextFromParent,
				canRecurse: childDepth < rlm.maxDepth,
				maxTurns: rlm.maxTurns,
				outputCapChars: rlm.outputCapChars,
			}),
			repl,
			model: llm.model,
			apiKey: llm.apiKey,
			headers: llm.headers,
			maxTurns: rlm.maxTurns,
			budget: llm.budget,
			outputCapChars: rlm.outputCapChars,
			signal: llm.signal,
			completeFn: rlm.completeFn,
			onEvent: rlm.logger ? loggingOnEvent(rlm.logger, childInv) : undefined,
		});

		emitEnd(result.stopReason, result.turns);

		if (result.stopReason === "error") {
			throw new Error(`rlm_query: nested investigation failed: ${result.answer}`);
		}
		if (result.stopReason === "aborted") {
			throw new Error("rlm_query aborted");
		}
		// final/no_code/max_turns/budget: the (possibly stop-note-prefixed) answer
		// string is informative — the parent reads it and judges usability.
		return result.answer;
	} catch (err) {
		// ready()/setVar()/REPL failures throw before the investigation reports a
		// stop reason; emit an end event so the transcript never shows a started
		// run without a finished line. No-op when the end was already emitted.
		emitEnd(llm.signal?.aborted ? "aborted" : "error", 0);
		throw err;
	} finally {
		await repl.close();
	}
}

function rpcResultChars(value: unknown): number {
	if (typeof value === "string") return value.length;
	try {
		return JSON.stringify(value)?.length ?? String(value).length;
	} catch {
		return String(value).length;
	}
}

/**
 * Wraps every handler with a timing decorator that logs one "rpc" event per
 * call under the owner's inv id. Known accepted gaps: the unknown-method and
 * handler-timeout paths live in repl.ts and are not logged (a handler that
 * loses its timeout race logs late on settle and is dropped post-close); both
 * are visible in the exec traceback anyway.
 */
function withRpcLogging(handlers: RpcHandlers, logger: RlmLogger, inv: string): RpcHandlers {
	const wrapped: RpcHandlers = {};
	for (const [method, entry] of Object.entries(handlers)) {
		const handler = typeof entry === "function" ? entry : entry.handler;
		const logged: RpcHandler = async (args) => {
			const start = Date.now();
			try {
				const value = await handler(args);
				logger.log({
					inv,
					event: "rpc",
					method,
					ok: true,
					durationMs: Date.now() - start,
					argsPreview: preview(args),
					resultPreview: preview(value),
					resultChars: rpcResultChars(value),
				});
				return value;
			} catch (err) {
				logger.log({
					inv,
					event: "rpc",
					method,
					ok: false,
					durationMs: Date.now() - start,
					argsPreview: preview(args),
					error: err instanceof Error ? err.message : String(err),
				});
				throw err;
			}
		};
		wrapped[method] = typeof entry === "function" ? logged : { handler: logged, timeoutMs: entry.timeoutMs };
	}
	return wrapped;
}

export function createRpcHandlers(kb: AgentKBOptions, llm: LlmOptions, rlm: RlmRecursionOptions): RpcHandlers {
	// One counter per handler set (i.e. per investigation), so sibling children
	// of one parent get ".1", ".2", ... in call order.
	let childSeq = 0;
	const nextChildInv = () => `${rlm.inv ?? "root"}.${++childSeq}`;

	const handlers: RpcHandlers = {
		async kb_search(args: unknown) {
			const obj = asRecord(args, "kb_search");

			const query = obj.query;
			if (typeof query !== "string" || !query.trim()) {
				throw new Error("kb_search: query must be a non-empty string");
			}

			const kRaw = obj.k ?? 5;
			const k = Number(kRaw);
			if (!Number.isFinite(k)) {
				throw new Error("kb_search: k must be a number");
			}

			const scopeRaw = obj.scope ?? "wiki";
			if (typeof scopeRaw !== "string" || !scopeRaw.trim()) {
				throw new Error("kb_search: scope must be a non-empty string");
			}

			return kbSearch(kb, query, Math.trunc(k), scopeRaw);
		},

		async kb_read(args: unknown) {
			const obj = asRecord(args, "kb_read");

			const filePath = obj.path;
			if (typeof filePath !== "string" || !filePath.trim()) {
				throw new Error("kb_read: path must be a non-empty string");
			}

			return kbRead(kb, filePath);
		},

		llm_query: {
			timeoutMs: LLM_RPC_TIMEOUT_MS,
			async handler(args: unknown) {
				const obj = asRecord(args, "llm_query");

				const prompt = obj.prompt;
				if (typeof prompt !== "string" || !prompt.trim()) {
					throw new Error("llm_query: prompt must be a non-empty string");
				}

				return runAnalystCall(llm, prompt);
			},
		},

		llm_query_batched: {
			timeoutMs: LLM_BATCH_RPC_TIMEOUT_MS,
			async handler(args: unknown) {
				const obj = asRecord(args, "llm_query_batched");

				const prompts = obj.prompts;
				if (!Array.isArray(prompts)) {
					throw new Error("llm_query_batched: prompts must be a list of strings");
				}
				if (prompts.length === 0) return [];
				if (prompts.length > MAX_BATCH_PROMPTS) {
					throw new Error(
						`llm_query_batched: at most ${MAX_BATCH_PROMPTS} prompts per batch, got ${prompts.length}; split the batch`,
					);
				}
				for (const p of prompts) {
					if (typeof p !== "string" || !p.trim()) {
						throw new Error("llm_query_batched: every prompt must be a non-empty string");
					}
				}

				// Per-item error containment: one bad item must not discard the
				// spend of its siblings; failures become error strings in place.
				return mapWithConcurrencyLimit(prompts as string[], LLM_BATCH_CONCURRENCY, async (prompt) => {
					try {
						return await runAnalystCall(llm, prompt);
					} catch (err) {
						return `[llm_query error: ${err instanceof Error ? err.message : String(err)}]`;
					}
				});
			},
		},

		rlm_query: {
			timeoutMs: RLM_RPC_TIMEOUT_MS,
			async handler(args: unknown) {
				const obj = asRecord(args, "rlm_query");

				const prompt = obj.prompt;
				if (typeof prompt !== "string" || !prompt.trim()) {
					throw new Error("rlm_query: prompt must be a non-empty string");
				}

				// The namespace contract says context is a list; enforce it.
				const context = obj.context;
				if (context !== null && context !== undefined && !Array.isArray(context)) {
					throw new Error("rlm_query: context must be a list or None");
				}

				return runNestedRlmQuery(kb, llm, rlm, prompt, context, nextChildInv);
			},
		},

		rlm_query_batched: {
			timeoutMs: RLM_BATCH_RPC_TIMEOUT_MS,
			async handler(args: unknown) {
				const obj = asRecord(args, "rlm_query_batched");

				const prompts = obj.prompts;
				if (!Array.isArray(prompts)) {
					throw new Error("rlm_query_batched: prompts must be a list of strings");
				}
				if (prompts.length === 0) return [];
				if (prompts.length > MAX_RLM_BATCH_PROMPTS) {
					throw new Error(
						`rlm_query_batched: at most ${MAX_RLM_BATCH_PROMPTS} prompts per batch, got ${prompts.length}; split the batch`,
					);
				}
				for (const p of prompts) {
					if (typeof p !== "string" || !p.trim()) {
						throw new Error("rlm_query_batched: every prompt must be a non-empty string");
					}
				}

				// A contexts length mismatch is a whole-batch validation error
				// (a calling bug, not an item failure).
				const contexts = obj.contexts;
				if (contexts !== null && contexts !== undefined) {
					if (!Array.isArray(contexts)) {
						throw new Error("rlm_query_batched: contexts must be a list or None");
					}
					if (contexts.length !== prompts.length) {
						throw new Error(
							`rlm_query_batched: contexts length (${contexts.length}) must match prompts length (${prompts.length})`,
						);
					}
					for (const c of contexts) {
						if (c !== null && c !== undefined && !Array.isArray(c)) {
							throw new Error("rlm_query_batched: every context must be a list or None");
						}
					}
				}

				// Per-item error containment: one bad child must not discard its
				// siblings' completed (and paid-for) work.
				return mapWithConcurrencyLimit(prompts as string[], RLM_BATCH_CONCURRENCY, async (prompt, index) => {
					try {
						return await runNestedRlmQuery(
							kb,
							llm,
							rlm,
							prompt,
							Array.isArray(contexts) ? contexts[index] : undefined,
							nextChildInv,
						);
					} catch (err) {
						return `[rlm_query error: ${err instanceof Error ? err.message : String(err)}]`;
					}
				});
			},
		},
	};

	return rlm.logger ? withRpcLogging(handlers, rlm.logger, rlm.inv ?? "root") : handlers;
}
