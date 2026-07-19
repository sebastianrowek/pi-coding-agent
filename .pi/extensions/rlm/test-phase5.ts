import * as assert from "node:assert";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { AgentKBHit, AgentKBOptions, kbSearch } from "./agentkb.ts";
import { BudgetTracker } from "./budget.ts";
import { type CompleteFn, type InvestigatorEvent, runInvestigation } from "./investigator.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl, type RpcHandlers } from "./repl.ts";
import { createRpcHandlers, type LlmOptions, type RlmRecursionOptions } from "./rpc.ts";

const PYTHON = process.env.RLM_PYTHON ?? "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

let unhandledRejections = 0;
process.on("unhandledRejection", (reason) => {
	unhandledRejections++;
	console.error("UNHANDLED REJECTION:", reason);
	process.exitCode = 1;
});

const FAKE_MODEL: Model<Api> = {
	id: "fake-model",
	name: "Fake Model",
	api: "openai-completions",
	provider: "fake",
	baseUrl: "http://localhost:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

/** Never reached: every test injects kbSearchFn or provides parent context. */
const DUMMY_KB: AgentKBOptions = {
	pythonPath: "python",
	agentkbCwd: "C:\\nonexistent-agentkb",
};

const SYSTEM_PROMPT = buildSystemPrompt({ contextCount: 0, canRecurse: true, maxTurns: 12, outputCapChars: 10_000 });

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeAssistant(
	text: string,
	costUsd = 0.01,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function codeReply(prose: string, code: string, costUsd = 0.01): AssistantMessage {
	return fakeAssistant(`${prose}\n\n\`\`\`python\n${code}\n\`\`\``, costUsd);
}

/** Queue-scripted completeFn that records every Context it was called with. */
function scriptedComplete(replies: AssistantMessage[]): { fn: CompleteFn; contexts: Context[] } {
	const contexts: Context[] = [];
	const queue = [...replies];
	const fn = (async (_model: Model<Api>, context: Context) => {
		contexts.push(structuredClone(context));
		const next = queue.shift();
		if (!next) throw new Error("scripted completeFn exhausted");
		return next;
	}) as CompleteFn;
	return { fn, contexts };
}

/** Analyst fake that answers every prompt with the same string, recording prompts. */
function recordingAnalyst(answer: string, costUsd = 0.01): { fn: CompleteFn; prompts: string[] } {
	const prompts: string[] = [];
	const fn = (async (_model: Model<Api>, context: Context) => {
		const last = context.messages[context.messages.length - 1];
		prompts.push(String(last?.content));
		return fakeAssistant(answer, costUsd);
	}) as CompleteFn;
	return { fn, prompts };
}

/** completeFn that must never be reached; trips the named flag if it is. */
function throwingComplete(label: string): { fn: CompleteFn; called: () => boolean } {
	let called = false;
	const fn = (async () => {
		called = true;
		throw new Error(`${label} must not be reached`);
	}) as CompleteFn;
	return { fn, called: () => called };
}

type KbSearchFn = typeof kbSearch;

/** kbSearchFn fake returning fixed hits, recording (query, k, scope) per call. */
function fakeKbSearch(hits: AgentKBHit[]): { fn: KbSearchFn; calls: { query: string; k?: number; scope?: string }[] } {
	const calls: { query: string; k?: number; scope?: string }[] = [];
	const fn = (async (_options: AgentKBOptions, query: string, k?: number, scope?: string) => {
		calls.push({ query, k, scope });
		return hits;
	}) as KbSearchFn;
	return { fn, calls };
}

function throwingKbSearch(message: string): { fn: KbSearchFn; calls: () => number } {
	let calls = 0;
	const fn = (async () => {
		calls++;
		throw new Error(message);
	}) as KbSearchFn;
	return { fn, calls: () => calls };
}

function makeRlm(overrides: Partial<RlmRecursionOptions>): RlmRecursionOptions {
	return {
		depth: 0,
		maxDepth: 2,
		replPythonPath: PYTHON,
		maxTurns: 4,
		outputCapChars: 10_000,
		k: 5,
		scope: "wiki",
		...overrides,
	};
}

function makeLlm(overrides: Partial<LlmOptions>): LlmOptions {
	return {
		model: FAKE_MODEL,
		budget: new BudgetTracker(10, 1_000),
		...overrides,
	};
}

function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		const t = setTimeout(() => reject(new Error("Test timeout")), ms);
		t.unref();
	});
}

async function run(name: string, fn: () => Promise<void>) {
	try {
		await Promise.race([fn(), timeout(30_000)]);
		console.log(`PASS: ${name}`);
	} catch (err) {
		console.error(`FAIL: ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

async function withRepl(handlers: RpcHandlers, fn: (repl: PythonRepl) => Promise<void>, signal?: AbortSignal) {
	const repl = new PythonRepl({ pythonPath: PYTHON, signal });
	repl.setRpcHandlers(handlers);
	try {
		await repl.ready();
		await fn(repl);
	} finally {
		await repl.close();
	}
}

async function main() {
	console.log("Phase 5 Tests\n");
	console.log("--- Host-level tests ---\n");

	// 1. Phase marker and nine builtins
	await run("Host Phase Marker and Builtins", async () => {
		await withRepl({}, async (repl) => {
			const res = await repl.exec(
				"print(_RLM_HOST_PHASE)\nprint(len(_RLM_BUILTINS))\nfor b in ['kb_search', 'kb_read', 'llm_query', 'llm_query_batched', 'rlm_query', 'rlm_query_batched', 'FINAL', 'FINAL_VAR', 'SHOW_VARS']:\n    print(b in _RLM_BUILTINS, callable(globals().get(b)))",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, `5\n9\n${"True True\n".repeat(9)}`);
		});
	});

	// 2. rlm_query round trip through a mock handler; context passthrough
	await run("rlm_query Mock Round Trip", async () => {
		const seen: unknown[] = [];
		const handlers: RpcHandlers = {
			rlm_query: (args: unknown) => {
				seen.push(args);
				return `mock answer for ${(args as Record<string, unknown>).prompt}`;
			},
		};
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec(
				"print(rlm_query('x'))\nprint(rlm_query('y', context=[{'path': 'p', 'snippet': 's'}]))",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "mock answer for x\nmock answer for y\n");
			assert.deepStrictEqual(seen, [
				{ prompt: "x", context: null },
				{ prompt: "y", context: [{ path: "p", snippet: "s" }] },
			]);
		});
	});

	// 3. Handler validation -> tracebacks
	await run("rlm_query Validation Errors", async () => {
		const child = throwingComplete("child investigator");
		const analyst = throwingComplete("analyst");
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ completeFn: analyst.fn }),
			makeRlm({ completeFn: child.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const badPrompt = await repl.exec("rlm_query(123)");
			assert.ok(badPrompt.error?.includes("RuntimeError"), `error: ${badPrompt.error}`);
			assert.ok(badPrompt.error?.includes("prompt must be a non-empty string"), `error: ${badPrompt.error}`);

			const badContext = await repl.exec("rlm_query('x', context='not a list')");
			assert.ok(badContext.error?.includes("context must be a list or None"), `error: ${badContext.error}`);
		});
		assert.strictEqual(child.called(), false);
		assert.strictEqual(analyst.called(), false);
	});

	// 4. rlm_query_batched: order, [] -> [], contexts length mismatch
	await run("rlm_query_batched Validation and Order", async () => {
		// maxDepth 0: every item downgrades to one analyst call — order is
		// observable without spawning child REPLs.
		const answers: Record<string, string> = { a: "A", b: "B" };
		const analystFn = (async (_model: Model<Api>, context: Context) => {
			const prompt = String(context.messages[context.messages.length - 1]?.content);
			return fakeAssistant(answers[prompt] ?? "?", 0.01);
		}) as CompleteFn;
		const handlers = createRpcHandlers(DUMMY_KB, makeLlm({ completeFn: analystFn }), makeRlm({ maxDepth: 0 }));
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query_batched(['a', 'b']))\nprint(rlm_query_batched([]))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "['A', 'B']\n[]\n");

			const mismatch = await repl.exec("rlm_query_batched(['a'], contexts=[[], []])");
			assert.ok(mismatch.error?.includes("must match prompts length"), `error: ${mismatch.error}`);

			const badItem = await repl.exec("rlm_query_batched(['a'], contexts=['not a list'])");
			assert.ok(badItem.error?.includes("every context must be a list or None"), `error: ${badItem.error}`);
		});
	});

	// 5. Non-JSON-serializable context fails cleanly; protocol stream intact
	await run("Non-Serializable Context Keeps Protocol Intact", async () => {
		await withRepl({}, async (repl) => {
			const res = await repl.exec("rlm_query('x', context={1, 2})");
			assert.ok(res.error?.includes("TypeError"), `error: ${res.error}`);
			assert.ok(res.error?.includes("not JSON serializable"), `error: ${res.error}`);

			const after = await repl.exec("print('alive')");
			assert.strictEqual(after.error, null);
			assert.strictEqual(after.stdout, "alive\n");
		});
	});

	console.log("\n--- Runner-level tests ---\n");

	// 6. Nested happy path
	await run("Nested Happy Path", async () => {
		const stats = { nestedRuns: 0 };
		const child = scriptedComplete([codeReply("Child.", "FINAL('child answer')")]);
		const search = fakeKbSearch([]);
		const analyst = throwingComplete("analyst");
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ completeFn: analyst.fn }),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn, stats }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("ans = rlm_query('sub')\nprint(ans)");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "child answer\n");
			assert.strictEqual(stats.nestedRuns, 1);

			// Child REPL closed, parent REPL still healthy.
			const after = await repl.exec("print('parent alive')");
			assert.strictEqual(after.stdout, "parent alive\n");
		});
		assert.strictEqual(analyst.called(), false);
	});

	// 7. Parent-provided context wins; no child search
	await run("Parent-Provided Context", async () => {
		const child = scriptedComplete([codeReply("Len.", "FINAL(str(len(context)))")]);
		const search = fakeKbSearch([{ path: "should-not-be-used" }]);
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({}),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query('sub', context=[{'path': 'x', 'snippet': 'y'}]))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "1\n");
		});
		assert.strictEqual(search.calls.length, 0);
		assert.ok(
			child.contexts[0]?.systemPrompt?.includes("provided by the parent investigation"),
			child.contexts[0]?.systemPrompt,
		);
	});

	// 8. Fresh child context via kbSearchFn
	await run("Fresh Child Context Search", async () => {
		const child = scriptedComplete([codeReply("Len.", "FINAL(str(len(context)))")]);
		const search = fakeKbSearch([
			{ path: "C:\\kb\\one.md", score: 1 },
			{ path: "C:\\kb\\two.md", score: 0.5 },
		]);
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({}),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn, k: 7, scope: "notes" }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query('sub'))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "2\n");
		});
		assert.deepStrictEqual(search.calls, [{ query: "sub", k: 7, scope: "notes" }]);
		assert.ok(
			child.contexts[0]?.systemPrompt?.includes("from an initial knowledge-base search"),
			child.contexts[0]?.systemPrompt,
		);
	});

	// 9. Child search failure degrades to empty context + prompt note
	await run("Child Search Failure Degrades", async () => {
		const child = scriptedComplete([codeReply("Len.", "FINAL(str(len(context)))")]);
		const search = throwingKbSearch("agentkb exploded");
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({}),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query('sub'))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "0\n");
		});
		assert.strictEqual(search.calls(), 1);
		assert.ok(child.contexts[0]?.systemPrompt?.includes("initial kb_search failed"), child.contexts[0]?.systemPrompt);
		assert.ok(child.contexts[0]?.systemPrompt?.includes("agentkb exploded"), child.contexts[0]?.systemPrompt);
	});

	// 10. Depth downgrade folds context into one analyst call
	await run("Depth Downgrade With Context", async () => {
		const stats = { nestedRuns: 0 };
		const child = throwingComplete("child investigator");
		const search = fakeKbSearch([]);
		const analyst = recordingAnalyst("analyst answer");
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ completeFn: analyst.fn }),
			makeRlm({ depth: 2, maxDepth: 2, completeFn: child.fn, kbSearchFn: search.fn, stats }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query('sub', context=[{'path': 'x'}]))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "analyst answer\n");
		});
		assert.strictEqual(child.called(), false);
		assert.strictEqual(search.calls.length, 0);
		assert.strictEqual(stats.nestedRuns, 0);
		assert.strictEqual(analyst.prompts.length, 1);
		assert.ok(analyst.prompts[0]?.startsWith("Context (from the parent investigation):"), analyst.prompts[0]);
		assert.ok(analyst.prompts[0]?.includes('[{"path":"x"}]'), analyst.prompts[0]);
		assert.ok(analyst.prompts[0]?.endsWith("Question: sub"), analyst.prompts[0]);
	});

	// 11. maxDepth 0 is a recursion kill switch
	await run("maxDepth 0 Kill Switch", async () => {
		const child = throwingComplete("child investigator");
		const analyst = recordingAnalyst("downgraded");
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ completeFn: analyst.fn }),
			makeRlm({ maxDepth: 0, completeFn: child.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("print(rlm_query('sub'))");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "downgraded\n");
		});
		assert.strictEqual(child.called(), false);
		// No context passed -> the prompt goes through verbatim.
		assert.deepStrictEqual(analyst.prompts, ["sub"]);
	});

	// 12. Budget pre-check: exhausted pool never spawns anything
	await run("Budget Pre-Check Before Spawn", async () => {
		const budget = new BudgetTracker(0.1, 1_000);
		budget.add(0.2); // already over
		const child = throwingComplete("child investigator");
		const analyst = throwingComplete("analyst");
		const search = fakeKbSearch([]);
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ budget, completeFn: analyst.fn }),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec(
				"try:\n    rlm_query('x')\nexcept RuntimeError as e:\n    print('ERR', 'budget exhausted' in str(e))",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "ERR True\n");
		});
		assert.strictEqual(child.called(), false);
		assert.strictEqual(analyst.called(), false);
		assert.strictEqual(search.calls.length, 0);
	});

	// 13. Shared pool across the tree: a child's spend trips the parent's budget
	await run("Shared Budget Across the Tree", async () => {
		const budget = new BudgetTracker(0.5, 1_000);
		const stats = { nestedRuns: 0 };
		const child = scriptedComplete([
			codeReply("Work 1.", "print('w1')", 0.2),
			codeReply("Work 2.", "print('w2')", 0.2),
		]);
		const search = fakeKbSearch([]);
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ budget }),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn, stats }),
		);
		const execResults: string[] = [];
		await withRepl(handlers, async (repl) => {
			const parent = scriptedComplete([codeReply("Recurse.", "ans = rlm_query('sub')\nprint(ans)", 0.2)]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget,
				outputCapChars: 10_000,
				completeFn: parent.fn,
				onEvent: (ev: InvestigatorEvent) => {
					if (ev.type === "exec_result") execResults.push(ev.text ?? "");
				},
			});
			// Spend: parent turn 0.2 + child turn1 0.2 + child turn2 0.2 = 0.6;
			// the child's turn-3 top-of-loop check trips the shared pool, then the
			// parent's turn-2 check trips it too.
			assert.strictEqual(result.stopReason, "budget");
			assert.strictEqual(result.turns, 1);
			assert.ok(Math.abs(result.costUsd - 0.6) < 1e-9, String(result.costUsd));
			assert.strictEqual(result.costUsd, budget.spentUsd);
			assert.strictEqual(budget.callCount, 3);
			assert.strictEqual(stats.nestedRuns, 1);
			// The child's best-effort stop note is a string the parent can read.
			assert.ok(
				execResults.some((t) => t.includes("[Investigation stopped: budget exhausted")),
				execResults.join("\n---\n"),
			);
		});
	});

	// 14. Child stopReason "error" -> parent-visible RuntimeError
	await run("Child Error Propagates", async () => {
		const errorReply = fakeAssistant("", 0, "error");
		errorReply.errorMessage = "child model exploded";
		const child = scriptedComplete([errorReply]);
		const search = fakeKbSearch([]);
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({}),
			makeRlm({ completeFn: child.fn, kbSearchFn: search.fn }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("rlm_query('sub')");
			assert.ok(res.error?.includes("RuntimeError"), `error: ${res.error}`);
			assert.ok(res.error?.includes("nested investigation failed"), `error: ${res.error}`);
			assert.ok(res.error?.includes("child model exploded"), `error: ${res.error}`);
		});
	});

	// 15. Batched: 4-way cap, order, per-item failure containment
	await run("Batched Nested Runs", async () => {
		const stats = { nestedRuns: 0 };
		const search = fakeKbSearch([]);
		let inFlight = 0;
		let highWater = 0;
		const childFn = (async (_model: Model<Api>, context: Context) => {
			const question = String(context.messages[0]?.content);
			inFlight++;
			highWater = Math.max(highWater, inFlight);
			await delay(300);
			inFlight--;
			if (question === "p3") {
				const reply = fakeAssistant("", 0, "error");
				reply.errorMessage = "p3 exploded";
				return reply;
			}
			return codeReply("Done.", `FINAL('ans:${question}')`, 0.001);
		}) as CompleteFn;
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({}),
			makeRlm({ completeFn: childFn, kbSearchFn: search.fn, stats }),
		);
		await withRepl(handlers, async (repl) => {
			const res = await repl.exec(
				"res = rlm_query_batched(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])\nfor r in res:\n    print(r)",
			);
			assert.strictEqual(res.error, null);
			const lines = res.stdout.trimEnd().split("\n");
			assert.strictEqual(lines.length, 6);
			assert.deepStrictEqual([lines[0], lines[1], lines[2]], ["ans:p0", "ans:p1", "ans:p2"]);
			assert.ok(lines[3]?.startsWith("[rlm_query error:"), lines[3]);
			assert.ok(lines[3]?.includes("p3 exploded"), lines[3]);
			assert.deepStrictEqual([lines[4], lines[5]], ["ans:p4", "ans:p5"]);
		});
		assert.ok(highWater <= 4, `high water ${highWater}`);
		assert.ok(highWater > 1, `high water ${highWater}`);
		assert.strictEqual(stats.nestedRuns, 6);
	});

	// 16. Abort mid-nested-run: whole tree ends aborted, nothing leaks
	await run("Abort Mid-Nested-Run", async () => {
		const controller = new AbortController();
		const budget = new BudgetTracker(10, 1_000);
		const search = fakeKbSearch([]);
		const nestedEvents: { phase: string; stopReason?: string }[] = [];
		const childFn = (async () => {
			await delay(50);
			controller.abort();
			// In-band aborted reply, as complete() reports it when the signal fires.
			return fakeAssistant("", 0, "aborted");
		}) as CompleteFn;
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ budget, signal: controller.signal }),
			makeRlm({
				completeFn: childFn,
				kbSearchFn: search.fn,
				onNested: (ev) => nestedEvents.push({ phase: ev.phase, stopReason: ev.stopReason }),
			}),
		);
		await withRepl(
			handlers,
			async (repl) => {
				const parent = scriptedComplete([codeReply("Recurse.", "print(rlm_query('sub'))", 0.01)]);
				const result = await runInvestigation({
					question: "q",
					systemPrompt: SYSTEM_PROMPT,
					repl,
					model: FAKE_MODEL,
					maxTurns: 10,
					budget,
					outputCapChars: 10_000,
					signal: controller.signal,
					completeFn: parent.fn,
				});
				assert.strictEqual(result.stopReason, "aborted");
				assert.strictEqual(result.costUsd, budget.spentUsd);
			},
			controller.signal,
		);
		// Give orphaned handler continuations a beat to settle (the runner's
		// finally still closes the child REPL on this path).
		await delay(200);
		assert.deepStrictEqual(nestedEvents, [
			{ phase: "start", stopReason: undefined },
			{ phase: "end", stopReason: "aborted" },
		]);
		assert.strictEqual(unhandledRejections, 0);
	});

	console.log("\n--- Loop-level test ---\n");

	// 17. End-to-end two-level recursion
	await run("End-to-End Recursion", async () => {
		const budget = new BudgetTracker(10, 1_000);
		const stats = { nestedRuns: 0 };
		const search = fakeKbSearch([]);
		const child = scriptedComplete([codeReply("Child.", "FINAL('child says hi')", 0.01)]);
		const nestedEvents: { phase: string; depth: number; stopReason?: string; turns?: number }[] = [];
		const handlers = createRpcHandlers(
			DUMMY_KB,
			makeLlm({ budget }),
			makeRlm({
				completeFn: child.fn,
				kbSearchFn: search.fn,
				stats,
				onNested: (ev) =>
					nestedEvents.push({ phase: ev.phase, depth: ev.depth, stopReason: ev.stopReason, turns: ev.turns }),
			}),
		);
		let doneEvents = 0;
		await withRepl(handlers, async (repl) => {
			const parent = scriptedComplete([
				codeReply("Recurse.", "answer = rlm_query('sub')", 0.01),
				codeReply("Done.", "FINAL('got: ' + answer)", 0.01),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget,
				outputCapChars: 10_000,
				completeFn: parent.fn,
				onEvent: (ev: InvestigatorEvent) => {
					if (ev.type === "done") doneEvents++;
				},
			});
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "got: child says hi");
			assert.strictEqual(result.turns, 2);
			assert.strictEqual(result.costUsd, budget.spentUsd);
			assert.ok(Math.abs(result.costUsd - 0.03) < 1e-9, String(result.costUsd));
		});
		assert.strictEqual(stats.nestedRuns, 1);
		assert.strictEqual(doneEvents, 1);
		assert.deepStrictEqual(nestedEvents, [
			{ phase: "start", depth: 1, stopReason: undefined, turns: undefined },
			{ phase: "end", depth: 1, stopReason: "final", turns: 1 },
		]);
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
