import * as assert from "node:assert";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { BudgetTracker } from "./budget.ts";
import { type CompleteFn, extractLastCodeBlock, type InvestigatorEvent, runInvestigation } from "./investigator.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl, type RpcHandlers } from "./repl.ts";

const PYTHON = process.env.RLM_PYTHON ?? "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

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

const SYSTEM_PROMPT = buildSystemPrompt({ contextCount: 1, canRecurse: false, maxTurns: 12, outputCapChars: 10_000 });

function mockHandlers(): RpcHandlers {
	return {
		kb_search: async () => [{ path: "C:\\kb\\mock.md", score: 1, title: "Mock Result" }],
		kb_read: async () => "Mock file content",
	};
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

/** completeFn that returns the same reply forever (for max_turns / budget tests). */
function repeatingComplete(text: string, costUsd: number): CompleteFn {
	return (async () => fakeAssistant(text, costUsd)) as CompleteFn;
}

function codeReply(prose: string, code: string): AssistantMessage {
	return fakeAssistant(`${prose}\n\n\`\`\`python\n${code}\n\`\`\``);
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

async function withRepl(fn: (repl: PythonRepl) => Promise<void>, handlers: RpcHandlers = mockHandlers()) {
	const repl = new PythonRepl({ pythonPath: PYTHON });
	repl.setRpcHandlers(handlers);
	try {
		await repl.ready();
		await fn(repl);
	} finally {
		await repl.close();
	}
}

async function main() {
	console.log("Phase 3 Tests\n");
	console.log("--- Extraction unit tests ---\n");

	// 0. extractLastCodeBlock edge cases (no REPL needed)
	await run("Code Block Extraction Edge Cases", async () => {
		assert.strictEqual(extractLastCodeBlock("prose only, no fence"), null);
		assert.strictEqual(extractLastCodeBlock("```python\nprint(1)\n"), null); // unterminated fence
		assert.strictEqual(extractLastCodeBlock("```python\n   \n```"), null); // whitespace-only block
		assert.strictEqual(extractLastCodeBlock("```python\r\nprint(1)\r\n```"), "print(1)\r\n"); // CRLF
		assert.strictEqual(extractLastCodeBlock("```python\na = 1\n```\ntext\n```python\nb = 2\n```"), "b = 2\n");
	});

	console.log("\n--- Host-level tests ---\n");

	// 1. Phase marker and builtins list
	await run("Host Phase Marker and Builtins", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(
				"print(_RLM_HOST_PHASE)\nfor b in ['kb_search', 'kb_read', 'FINAL', 'FINAL_VAR', 'SHOW_VARS']:\n    print(b in _RLM_BUILTINS, callable(globals()[b]) if b in globals() else False)",
			);
			assert.strictEqual(res.error, null);
			// Host phase marker advances with later phases; 5 since Phase 5.
			assert.strictEqual(res.stdout, "5\nTrue True\nTrue True\nTrue True\nTrue True\nTrue True\n");
		});
	});

	// 2. FINAL stops the block; code after it does not run
	await run("FINAL Stops the Block", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("print('before')\nFINAL('done')\nleaked = True\nprint('after')");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.final, "done");
			assert.strictEqual(res.stdout, "before\n");
			const res2 = await repl.exec("print('leaked' in globals())");
			assert.strictEqual(res2.stdout, "False\n");
		});
	});

	// 3. FINAL with a dict serializes to JSON
	await run("FINAL with Non-String Answer", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("FINAL({'a': 1, 'b': 'zwei'})");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.final, '{"a": 1, "b": "zwei"}');
		});
	});

	// 4. FINAL_VAR returns the named variable; missing name -> NameError
	await run("FINAL_VAR", async () => {
		await withRepl(async (repl) => {
			await repl.exec("x = 'answer'");
			const res = await repl.exec("FINAL_VAR('x')");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.final, "answer");
			const res2 = await repl.exec("FINAL_VAR('missing')");
			assert.strictEqual(res2.final, null);
			assert.ok(res2.error?.includes("NameError"), `error: ${res2.error}`);
		});
	});

	// 5. FINAL is not swallowed by `except Exception:`
	await run("FINAL Survives except Exception", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(
				"try:\n    FINAL('caught?')\nexcept Exception:\n    print('swallowed')\nprint('after')",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.final, "caught?");
			assert.strictEqual(res.stdout, "");
		});
	});

	// 6. SHOW_VARS lists user variables, excludes preinstalled entries
	await run("SHOW_VARS", async () => {
		await withRepl(async (repl) => {
			const empty = await repl.exec("print(SHOW_VARS())");
			assert.strictEqual(empty.stdout, "(no user variables)\n");
			const res = await repl.exec("myvar = 42\nsummary = SHOW_VARS()\nprint(summary)");
			assert.strictEqual(res.error, null);
			assert.ok(res.stdout.includes("myvar: int = 42"), res.stdout);
			assert.ok(!res.stdout.includes("kb_search"), res.stdout);
			assert.ok(!res.stdout.includes("_RLM_BUILTINS"), res.stdout);
		});
	});

	// 7. Stale final does not leak into a later exec
	await run("Stale Final Reset", async () => {
		await withRepl(async (repl) => {
			const res1 = await repl.exec("FINAL('first')");
			assert.strictEqual(res1.final, "first");
			const res2 = await repl.exec("print('plain block')");
			assert.strictEqual(res2.final, null);
			assert.strictEqual(res2.stdout, "plain block\n");
		});
	});

	// 8. setVar round-trips native objects incl. non-ASCII
	await run("setVar Round Trip", async () => {
		await withRepl(async (repl) => {
			await repl.setVar("context", [{ path: "C:\\kb\\a.md", title: "Über ä😀", score: 0.9 }]);
			const res = await repl.exec(
				"print(type(context).__name__, len(context))\nprint(context[0]['title'])\nprint(context[0]['score'])",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "list 1\nÜber ä😀\n0.9\n");
			await assert.rejects(repl.setVar("", []), /name must be a non-empty string/);
			const alive = await repl.exec("print('still alive')");
			assert.strictEqual(alive.stdout, "still alive\n");
		});
	});

	console.log("\n--- Loop-level tests ---\n");

	// 9. Happy path: print from context, then FINAL
	await run("Happy Path", async () => {
		await withRepl(async (repl) => {
			await repl.setVar("context", [{ path: "C:\\kb\\a.md", title: "Hit" }]);
			const { fn } = scriptedComplete([
				codeReply("Looking at the context.", "print(len(context), context[0]['title'])"),
				codeReply("Got it.", "FINAL('the answer')"),
			]);
			const result = await runInvestigation({
				question: "What is in the context?",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.answer, "the answer");
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.turns, 2);
			assert.ok(result.costUsd > 0);
		});
	});

	// 10. No code block ends the investigation with the prose as answer
	await run("No Code Block", async () => {
		await withRepl(async (repl) => {
			const { fn } = scriptedComplete([fakeAssistant("Just prose, no code.")]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "no_code");
			assert.strictEqual(result.answer, "Just prose, no code.");
			assert.strictEqual(result.turns, 1);
		});
	});

	// 11. Error recovery: traceback shows up in the next turn's observation
	await run("Error Recovery", async () => {
		await withRepl(async (repl) => {
			const { fn, contexts } = scriptedComplete([
				codeReply("Try this.", "1 / 0"),
				codeReply("Oops, recovering.", "FINAL('recovered')"),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "recovered");
			const secondCall = contexts[1]!;
			const observation = secondCall.messages[secondCall.messages.length - 1]!;
			assert.strictEqual(observation.role, "user");
			assert.ok(String(observation.content).includes("ZeroDivisionError"), String(observation.content));
		});
	});

	// 12. max_turns: code without FINAL forever; done event fires on this exit too
	await run("Max Turns", async () => {
		await withRepl(async (repl) => {
			const events: InvestigatorEvent[] = [];
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 3,
				budget: new BudgetTracker(10, 1_000),
				outputCapChars: 10_000,
				completeFn: repeatingComplete("Still going.\n\n```python\nprint('turn')\n```", 0.001),
				onEvent: (ev) => events.push(ev),
			});
			assert.strictEqual(result.stopReason, "max_turns");
			assert.strictEqual(result.turns, 3);
			assert.ok(result.answer.includes("[Investigation stopped: turn limit reached"), result.answer);
			assert.ok(result.answer.includes("Still going."), result.answer);
			const lastEvent = events[events.length - 1]!;
			assert.strictEqual(lastEvent.type, "done");
			assert.strictEqual(lastEvent.turn, 3);
		});
	});

	// 13. Budget: 0.30 per call, 0.50 max -> stops after turn 2
	await run("Budget Exhausted", async () => {
		await withRepl(async (repl) => {
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 10,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: repeatingComplete("Spending.\n\n```python\nprint('turn')\n```", 0.3),
			});
			assert.strictEqual(result.stopReason, "budget");
			assert.strictEqual(result.turns, 2);
			assert.ok(Math.abs(result.costUsd - 0.6) < 1e-9, String(result.costUsd));
			assert.ok(result.answer.includes("[Investigation stopped: budget exhausted"), result.answer);
		});
	});

	// 14. Output capping: head+tail with omission marker
	await run("Output Capping", async () => {
		await withRepl(async (repl) => {
			const { fn, contexts } = scriptedComplete([
				codeReply("Big output.", "print('A' * 50000 + 'B' * 50000)"),
				codeReply("Done.", "FINAL('ok')"),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "final");
			const secondCall = contexts[1]!;
			const observation = String(secondCall.messages[secondCall.messages.length - 1]!.content);
			assert.ok(observation.length <= 10_000 + 200, `observation too long: ${observation.length}`);
			assert.ok(observation.includes("[output truncated:"), observation.slice(0, 200));
			assert.ok(observation.includes("AAAA"), "missing head content");
			assert.ok(observation.includes("BBBB"), "missing tail content");
		});
	});

	// 15. Last-block extraction: only the second fenced block executes
	await run("Last Code Block Wins", async () => {
		await withRepl(async (repl) => {
			const reply = fakeAssistant(
				"Plan:\n\n```python\nwrong = True\nprint('first block')\n```\n\nReal code:\n\n```python\nFINAL('second block')\n```",
			);
			const { fn } = scriptedComplete([reply]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "second block");
			assert.strictEqual(result.turns, 1);
			const check = await repl.exec("print('wrong' in globals())");
			assert.strictEqual(check.stdout, "False\n");
		});
	});

	// 16. completeFn reports stopReason "error" in-band
	await run("Model Error In-Band", async () => {
		await withRepl(async (repl) => {
			const errorReply = fakeAssistant("", 0, "error");
			errorReply.errorMessage = "boom from provider";
			const { fn } = scriptedComplete([errorReply]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "error");
			assert.ok(result.answer.includes("boom from provider"), result.answer);
		});
	});

	// 16b. stopReason "length": truncated reply is never executed; the model is
	// nudged to resend and the loop continues
	await run("Length-Truncated Reply Retries", async () => {
		await withRepl(async (repl) => {
			const truncated = fakeAssistant(
				"Long preamble.\n\n```python\nleaked_from_truncated = True\nprint('cut o",
				0.01,
				"length",
			);
			const { fn, contexts } = scriptedComplete([truncated, codeReply("Retrying shorter.", "FINAL('ok')")]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
			});
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "ok");
			assert.strictEqual(result.turns, 2);
			const secondCall = contexts[1]!;
			const nudge = secondCall.messages[secondCall.messages.length - 1]!;
			assert.strictEqual(nudge.role, "user");
			assert.ok(String(nudge.content).includes("cut off"), String(nudge.content));
			const check = await repl.exec("print('leaked_from_truncated' in globals())");
			assert.strictEqual(check.stdout, "False\n");
		});
	});

	// 17. Abort between turns
	await run("Abort Between Turns", async () => {
		const controller = new AbortController();
		const repl = new PythonRepl({ pythonPath: PYTHON, signal: controller.signal });
		repl.setRpcHandlers(mockHandlers());
		try {
			await repl.ready();
			const { fn } = scriptedComplete([
				codeReply("Turn one.", "print('working')"),
				codeReply("Should never run.", "FINAL('nope')"),
			]);
			const result = await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				signal: controller.signal,
				completeFn: fn,
				onEvent: (ev) => {
					if (ev.type === "exec_result") controller.abort();
				},
			});
			assert.strictEqual(result.stopReason, "aborted");
			assert.strictEqual(result.turns, 1);
		} finally {
			await repl.close();
		}
	});

	// 18. Event ordering for the happy path
	await run("Event Order", async () => {
		await withRepl(async (repl) => {
			const events: InvestigatorEvent[] = [];
			const { fn } = scriptedComplete([codeReply("First.", "print('one')"), codeReply("Second.", "FINAL('done')")]);
			await runInvestigation({
				question: "q",
				systemPrompt: SYSTEM_PROMPT,
				repl,
				model: FAKE_MODEL,
				maxTurns: 12,
				budget: new BudgetTracker(0.5, 1_000),
				outputCapChars: 10_000,
				completeFn: fn,
				onEvent: (ev) => events.push(ev),
			});
			const sequence = events.map((ev) => `${ev.turn}:${ev.type}`);
			assert.deepStrictEqual(sequence, [
				"1:turn_start",
				"1:assistant_text",
				"1:code_block",
				"1:exec_result",
				"2:turn_start",
				"2:assistant_text",
				"2:code_block",
				"2:exec_result",
				"2:done",
			]);
		});
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
