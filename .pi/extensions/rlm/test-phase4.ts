import * as assert from "node:assert";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { AgentKBOptions } from "./agentkb.ts";
import { BudgetTracker } from "./budget.ts";
import { type CompleteFn, runInvestigation } from "./investigator.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl, type RpcHandler, type RpcHandlers } from "./repl.ts";
import { createRpcHandlers, type LlmOptions, mapWithConcurrencyLimit, type RlmRecursionOptions } from "./rpc.ts";

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

/** Never reached by any test: the KB handlers are not exercised in Phase 4. */
const DUMMY_KB: AgentKBOptions = {
	pythonPath: "python",
	agentkbCwd: "C:\\nonexistent-agentkb",
};

const SYSTEM_PROMPT = buildSystemPrompt({ contextCount: 0, canRecurse: false, maxTurns: 12, outputCapChars: 10_000 });

/** maxDepth 0: nothing recurses; the child investigator must never be reached. */
const NO_RECURSION_RLM: RlmRecursionOptions = {
	depth: 0,
	maxDepth: 0,
	replPythonPath: PYTHON,
	maxTurns: 4,
	outputCapChars: 10_000,
	k: 5,
	scope: "wiki",
	completeFn: (async () => {
		throw new Error("child investigator must not be reached in Phase 4 tests");
	}) as CompleteFn,
};

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

interface FakeLlm {
	fn: CompleteFn;
	/** Prompts in call order. */
	calls: string[];
	maxConcurrency: () => number;
}

/**
 * Analyst CompleteFn that answers from a canned prompt->answer map, recording
 * call order and the high-water concurrency mark. Prompts mapped to an Error
 * make that call throw (transport failure).
 */
function fakeLlm(answers: Record<string, string | Error>, costUsd = 0.01): FakeLlm {
	const calls: string[] = [];
	let inFlight = 0;
	let highWater = 0;
	const fn = (async (_model: Model<Api>, context: Context) => {
		const last = context.messages[context.messages.length - 1];
		const prompt = String(last?.content);
		calls.push(prompt);
		inFlight++;
		highWater = Math.max(highWater, inFlight);
		await delay(10);
		inFlight--;
		const answer = answers[prompt];
		if (answer === undefined) throw new Error(`fakeLlm: no canned answer for prompt: ${prompt}`);
		if (answer instanceof Error) throw answer;
		return fakeAssistant(answer, costUsd);
	}) as CompleteFn;
	return { fn, calls, maxConcurrency: () => highWater };
}

function scriptedComplete(replies: AssistantMessage[]): CompleteFn {
	const queue = [...replies];
	return (async () => {
		const next = queue.shift();
		if (!next) throw new Error("scripted completeFn exhausted");
		return next;
	}) as CompleteFn;
}

function codeReply(prose: string, code: string, costUsd = 0.01): AssistantMessage {
	return fakeAssistant(`${prose}\n\n\`\`\`python\n${code}\n\`\`\``, costUsd);
}

function llmHandlers(llm: LlmOptions): RpcHandlers {
	return createRpcHandlers(DUMMY_KB, llm, NO_RECURSION_RLM);
}

function getHandler(handlers: RpcHandlers, method: string): RpcHandler {
	const entry = handlers[method];
	if (!entry) throw new Error(`no handler for ${method}`);
	return typeof entry === "function" ? entry : entry.handler;
}

function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		const t = setTimeout(() => reject(new Error("Test timeout")), ms);
		t.unref();
	});
}

async function run(name: string, fn: () => Promise<void>) {
	try {
		await Promise.race([fn(), timeout(20_000)]);
		console.log(`PASS: ${name}`);
	} catch (err) {
		console.error(`FAIL: ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

async function withRepl(
	handlers: RpcHandlers,
	fn: (repl: PythonRepl) => Promise<void>,
	options: { execTimeoutMs?: number } = {},
) {
	const repl = new PythonRepl({ pythonPath: PYTHON, ...options });
	repl.setRpcHandlers(handlers);
	try {
		await repl.ready();
		await fn(repl);
	} finally {
		await repl.close();
	}
}

async function main() {
	console.log("Phase 4 Tests\n");
	console.log("--- Unit tests (no REPL) ---\n");

	// 1. BudgetTracker basics
	await run("BudgetTracker", async () => {
		const b = new BudgetTracker(0.5, 3);
		assert.strictEqual(b.exhausted(), false);
		assert.strictEqual(b.remainingUsd, 0.5);
		b.add(0.2);
		assert.strictEqual(b.spentUsd, 0.2);
		assert.strictEqual(b.callCount, 1);
		assert.strictEqual(b.exhausted(), false);
		b.add(0.4);
		assert.strictEqual(b.exhausted(), true); // tripped on USD
		assert.strictEqual(b.remainingUsd, 0); // floors at 0
		b.add(0.1); // add after exhaustion still records: overshoot stays visible
		assert.ok(Math.abs(b.spentUsd - 0.7) < 1e-9, String(b.spentUsd));
		assert.strictEqual(b.callCount, 3);

		const byCalls = new BudgetTracker(100, 2);
		byCalls.add(0);
		assert.strictEqual(byCalls.exhausted(), false);
		byCalls.add(0);
		assert.strictEqual(byCalls.exhausted(), true); // tripped on call count
	});

	// 2. mapWithConcurrencyLimit
	await run("mapWithConcurrencyLimit", async () => {
		let inFlight = 0;
		let highWater = 0;
		// Later items finish earlier, so order preservation is actually exercised.
		const results = await mapWithConcurrencyLimit([0, 1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
			inFlight++;
			highWater = Math.max(highWater, inFlight);
			await delay((8 - item) * 5);
			inFlight--;
			return item * 2;
		});
		assert.deepStrictEqual(results, [0, 2, 4, 6, 8, 10, 12, 14]);
		assert.ok(highWater <= 3, `high water ${highWater}`);
		assert.ok(highWater > 1, `high water ${highWater}`);

		await assert.rejects(
			mapWithConcurrencyLimit([1, 2, 3], 2, async (item) => {
				if (item === 2) throw new Error("item two failed");
				return item;
			}),
			/item two failed/,
		);
	});

	console.log("\n--- Host-level tests ---\n");

	// 3. Phase marker and nine builtins
	await run("Host Phase Marker and Builtins", async () => {
		const llm = fakeLlm({});
		await withRepl(
			llmHandlers({ model: FAKE_MODEL, budget: new BudgetTracker(10, 100), completeFn: llm.fn }),
			async (repl) => {
				const res = await repl.exec(
					"print(_RLM_HOST_PHASE)\nprint(len(_RLM_BUILTINS))\nfor b in ['kb_search', 'kb_read', 'llm_query', 'llm_query_batched', 'rlm_query', 'rlm_query_batched', 'FINAL', 'FINAL_VAR', 'SHOW_VARS']:\n    print(b in _RLM_BUILTINS, callable(globals().get(b)))",
				);
				assert.strictEqual(res.error, null);
				assert.strictEqual(res.stdout, `5\n9\n${"True True\n".repeat(9)}`);
			},
		);
	});

	// 4. llm_query returns the mock string, printable from Python
	await run("llm_query Round Trip", async () => {
		const llm = fakeLlm({ "what is x": "x is 42" });
		await withRepl(
			llmHandlers({ model: FAKE_MODEL, budget: new BudgetTracker(10, 100), completeFn: llm.fn }),
			async (repl) => {
				const res = await repl.exec("answer = llm_query('what is x')\nprint(type(answer).__name__, answer)");
				assert.strictEqual(res.error, null);
				assert.strictEqual(res.stdout, "str x is 42\n");
				assert.deepStrictEqual(llm.calls, ["what is x"]);
			},
		);
	});

	// 5. llm_query with a non-string prompt -> validation traceback
	await run("llm_query Validation Error", async () => {
		const llm = fakeLlm({});
		await withRepl(
			llmHandlers({ model: FAKE_MODEL, budget: new BudgetTracker(10, 100), completeFn: llm.fn }),
			async (repl) => {
				const res = await repl.exec("llm_query(123)");
				assert.ok(res.error?.includes("RuntimeError"), `error: ${res.error}`);
				assert.ok(res.error?.includes("prompt must be a non-empty string"), `error: ${res.error}`);
				assert.strictEqual(llm.calls.length, 0);
			},
		);
	});

	// 6. llm_query_batched: order preserved, [] -> [], non-list -> traceback
	await run("llm_query_batched Round Trip", async () => {
		const llm = fakeLlm({ a: "A", b: "B", c: "C" });
		await withRepl(
			llmHandlers({ model: FAKE_MODEL, budget: new BudgetTracker(10, 100), completeFn: llm.fn }),
			async (repl) => {
				const res = await repl.exec("print(llm_query_batched(['a', 'b', 'c']))\nprint(llm_query_batched([]))");
				assert.strictEqual(res.error, null);
				assert.strictEqual(res.stdout, "['A', 'B', 'C']\n[]\n");

				const bad = await repl.exec("llm_query_batched('nope')");
				assert.ok(bad.error?.includes("prompts must be a list"), `error: ${bad.error}`);
			},
		);
	});

	// 7. Per-item failure containment: failed item becomes an error string
	await run("Batched Per-Item Failure", async () => {
		const llm = fakeLlm({ a: "A", b: new Error("b exploded"), c: "C" });
		await withRepl(
			llmHandlers({ model: FAKE_MODEL, budget: new BudgetTracker(10, 100), completeFn: llm.fn }),
			async (repl) => {
				const res = await repl.exec("res = llm_query_batched(['a', 'b', 'c'])\nfor r in res:\n    print(r)");
				assert.strictEqual(res.error, null);
				const lines = res.stdout.trimEnd().split("\n");
				assert.strictEqual(lines[0], "A");
				assert.ok(lines[1]?.startsWith("[llm_query error:"), lines[1]);
				assert.ok(lines[1]?.includes("b exploded"), lines[1]);
				assert.strictEqual(lines[2], "C");
			},
		);
	});

	console.log("\n--- Handler-level tests ---\n");

	// 8. Single call charges the budget
	await run("Single Call Charges Budget", async () => {
		const budget = new BudgetTracker(10, 100);
		const llm = fakeLlm({ hello: "world" }, 0.05);
		const handler = getHandler(llmHandlers({ model: FAKE_MODEL, budget, completeFn: llm.fn }), "llm_query");
		const result = await handler({ prompt: "hello" });
		assert.strictEqual(result, "world");
		assert.ok(Math.abs(budget.spentUsd - 0.05) < 1e-9, String(budget.spentUsd));
		assert.strictEqual(budget.callCount, 1);
	});

	// 9. Budget exhausted before the call: no completeFn invocation, Python sees RuntimeError
	await run("Budget Exhausted Before Call", async () => {
		const budget = new BudgetTracker(0.1, 100);
		budget.add(0.2); // already over
		const llm = fakeLlm({ x: "never" });
		const handlers = llmHandlers({ model: FAKE_MODEL, budget, completeFn: llm.fn });

		await assert.rejects(Promise.resolve(getHandler(handlers, "llm_query")({ prompt: "x" })), /budget exhausted/);
		assert.strictEqual(llm.calls.length, 0);

		await withRepl(handlers, async (repl) => {
			const res = await repl.exec("llm_query('x')");
			assert.ok(res.error?.includes("RuntimeError"), `error: ${res.error}`);
			assert.ok(res.error?.includes("budget exhausted"), `error: ${res.error}`);
		});
		assert.strictEqual(llm.calls.length, 0);
	});

	// 10. Batched concurrency cap: 40 prompts, high water <= 16 and > 1
	await run("Batched Concurrency Cap", async () => {
		const prompts = Array.from({ length: 40 }, (_, i) => `p${i}`);
		const answers: Record<string, string> = {};
		for (const p of prompts) answers[p] = p.toUpperCase();
		const llm = fakeLlm(answers, 0.001);
		const budget = new BudgetTracker(10, 1_000);
		const handler = getHandler(llmHandlers({ model: FAKE_MODEL, budget, completeFn: llm.fn }), "llm_query_batched");

		const results = (await handler({ prompts })) as string[];
		assert.deepStrictEqual(
			results,
			prompts.map((p) => p.toUpperCase()),
		);
		assert.ok(llm.maxConcurrency() <= 16, `high water ${llm.maxConcurrency()}`);
		assert.ok(llm.maxConcurrency() > 1, `high water ${llm.maxConcurrency()}`);
		assert.strictEqual(budget.callCount, 40);
	});

	// 11. Batched budget cut-off: head answered, tail budget-error strings
	await run("Batched Budget Cut-Off", async () => {
		const prompts = Array.from({ length: 40 }, (_, i) => `p${i}`);
		const answers: Record<string, string> = {};
		for (const p of prompts) answers[p] = p.toUpperCase();
		const llm = fakeLlm(answers, 0.2);
		const budget = new BudgetTracker(0.5, 1_000);
		const handler = getHandler(llmHandlers({ model: FAKE_MODEL, budget, completeFn: llm.fn }), "llm_query_batched");

		const results = (await handler({ prompts })) as string[];
		const answered = results.filter((r) => !r.startsWith("[llm_query error:"));
		const errored = results.filter((r) => r.startsWith("[llm_query error:"));
		// Already-launched siblings finish and are charged (overshoot accepted);
		// the not-yet-launched tail stops as soon as the pool is dry.
		assert.ok(answered.length >= 1, "expected some answered items");
		assert.ok(answered.length < 40, `expected a cut-off, all 40 answered`);
		assert.ok(
			errored.every((r) => r.includes("budget exhausted")),
			errored[0],
		);
		assert.ok(!results[0]!.startsWith("[llm_query error:"), `first item errored: ${results[0]}`);
		assert.ok(results[39]!.startsWith("[llm_query error:"), `last item answered: ${results[39]}`);
		assert.strictEqual(budget.callCount, answered.length);
		assert.ok(budget.spentUsd >= 0.5, String(budget.spentUsd));
	});

	// 12. Analyst stopReason "error": errorMessage surfaced, not charged
	await run("Analyst Error Not Charged", async () => {
		const budget = new BudgetTracker(10, 100);
		const errorReply = fakeAssistant("", 0.05, "error");
		errorReply.errorMessage = "boom from analyst provider";
		const handler = getHandler(
			llmHandlers({ model: FAKE_MODEL, budget, completeFn: scriptedComplete([errorReply]) }),
			"llm_query",
		);
		await assert.rejects(Promise.resolve(handler({ prompt: "x" })), /boom from analyst provider/);
		assert.strictEqual(budget.callCount, 0);
		assert.strictEqual(budget.spentUsd, 0);
	});

	// 13. Analyst stopReason "length": returned as text and charged
	await run("Analyst Length Reply Charged", async () => {
		const budget = new BudgetTracker(10, 100);
		const handler = getHandler(
			llmHandlers({
				model: FAKE_MODEL,
				budget,
				completeFn: scriptedComplete([fakeAssistant("truncated but usable", 0.05, "length")]),
			}),
			"llm_query",
		);
		const result = await handler({ prompt: "x" });
		assert.strictEqual(result, "truncated but usable");
		assert.strictEqual(budget.callCount, 1);
		assert.ok(Math.abs(budget.spentUsd - 0.05) < 1e-9, String(budget.spentUsd));
	});

	console.log("\n--- REPL/timeout integration tests ---\n");

	// 14. Exec timeout is suspended while an RPC is pending
	await run("Exec Timeout Suspended During RPC", async () => {
		const handlers: RpcHandlers = {
			llm_query: async () => {
				await delay(2_000);
				return "slow but fine";
			},
		};
		await withRepl(
			handlers,
			async (repl) => {
				const res = await repl.exec("print(llm_query('x'))");
				assert.strictEqual(res.error, null);
				assert.strictEqual(res.stdout, "slow but fine\n");
			},
			{ execTimeoutMs: 1_000 },
		);

		// Control: pure-Python compute under the same exec timeout still dies.
		const repl = new PythonRepl({ pythonPath: PYTHON, execTimeoutMs: 1_000 });
		try {
			await repl.ready();
			await assert.rejects(repl.exec("import time\ntime.sleep(2)\nprint('never')"), /Exec timeout/);
		} finally {
			await repl.close();
		}
	});

	// 15. Per-handler timeout applies and the exec timer is re-armed afterwards
	await run("Per-Handler RPC Timeout", async () => {
		const handlers: RpcHandlers = {
			llm_query: {
				timeoutMs: 200,
				handler: async () => {
					await delay(1_000);
					return "too late";
				},
			},
		};
		await withRepl(
			handlers,
			async (repl) => {
				const res = await repl.exec(
					"try:\n    llm_query('x')\nexcept RuntimeError as e:\n    print('caught', 'timed out after 200ms' in str(e))\nimport time\ntime.sleep(0.5)\nprint('still running')",
				);
				assert.strictEqual(res.error, null);
				// The 60s default did not apply (the 200ms override did), and the
				// block kept running for another 0.5s after the response — the exec
				// timer was re-armed fresh, not left counting RPC time.
				assert.strictEqual(res.stdout, "caught True\nstill running\n");
			},
			{ execTimeoutMs: 1_000 },
		);
	});

	console.log("\n--- Loop-level tests ---\n");

	// 16. Shared pool: investigator + analyst spend trip the same budget
	await run("Shared Budget Pool", async () => {
		const budget = new BudgetTracker(0.5, 1_000);
		const analyst = fakeLlm({ q1: "a1", q2: "a2" }, 0.2);
		const handlers = llmHandlers({ model: FAKE_MODEL, budget, completeFn: analyst.fn });
		await withRepl(handlers, async (repl) => {
			const investigator = scriptedComplete([
				codeReply("Delegating.", "print(llm_query('q1'))", 0.2),
				codeReply("Again.", "try:\n    llm_query('q2')\nexcept RuntimeError as e:\n    print('ERR', e)", 0.2),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget,
				outputCapChars: 10_000,
				completeFn: investigator,
			});
			// Spend: turn1 0.2 + analyst q1 0.2 + turn2 0.2 = 0.6; the q2 analyst
			// call is refused in-REPL; turn 3 trips the top-of-loop check.
			assert.strictEqual(result.stopReason, "budget");
			assert.strictEqual(result.turns, 2);
			assert.ok(Math.abs(result.costUsd - 0.6) < 1e-9, String(result.costUsd));
			assert.strictEqual(result.costUsd, budget.spentUsd); // 17. costUsd reports pool spend
			assert.strictEqual(budget.callCount, 3);
			assert.deepStrictEqual(analyst.calls, ["q1"]); // q2 refused pre-launch, never reaches the model
			assert.ok(result.answer.includes("budget exhausted"), result.answer);
		});
	});

	// 17. costUsd === budget.spentUsd on the final exit path too
	await run("costUsd Equals Pool Spend on FINAL", async () => {
		const budget = new BudgetTracker(10, 1_000);
		const analyst = fakeLlm({ q: "a" }, 0.03);
		const handlers = llmHandlers({ model: FAKE_MODEL, budget, completeFn: analyst.fn });
		await withRepl(handlers, async (repl) => {
			const investigator = scriptedComplete([
				codeReply("Ask.", "x = llm_query('q')", 0.02),
				codeReply("Done.", "FINAL(x)", 0.02),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget,
				outputCapChars: 10_000,
				completeFn: investigator,
			});
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "a");
			assert.strictEqual(result.costUsd, budget.spentUsd);
			assert.ok(Math.abs(result.costUsd - 0.07) < 1e-9, String(result.costUsd));
		});
	});

	// 18. Abort mid-batch: run ends aborted, no unhandled rejections
	await run("Abort Mid-Batch", async () => {
		const controller = new AbortController();
		const budget = new BudgetTracker(10, 1_000);
		let analystCalls = 0;
		const analystFn = (async (_model: Model<Api>, _context: Context, options?: { signal?: AbortSignal }) => {
			analystCalls++;
			await delay(30);
			controller.abort();
			// In-band aborted reply, as complete() reports it when the signal fires.
			assert.strictEqual(options?.signal?.aborted, true);
			return fakeAssistant("", 0, "aborted");
		}) as CompleteFn;

		const repl = new PythonRepl({ pythonPath: PYTHON, signal: controller.signal });
		repl.setRpcHandlers(llmHandlers({ model: FAKE_MODEL, budget, signal: controller.signal, completeFn: analystFn }));
		try {
			await repl.ready();
			const investigator = scriptedComplete([codeReply("Fan out.", "print(llm_query_batched(['a', 'b']))", 0.01)]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget,
				outputCapChars: 10_000,
				signal: controller.signal,
				completeFn: investigator,
			});
			assert.strictEqual(result.stopReason, "aborted");
			assert.strictEqual(result.costUsd, budget.spentUsd);
			assert.strictEqual(analystCalls, 2); // both items were in flight
		} finally {
			await repl.close();
		}
		// Give late batch continuations a beat to surface any unhandled rejection.
		await delay(100);
		assert.strictEqual(unhandledRejections, 0);
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
