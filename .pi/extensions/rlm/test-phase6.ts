import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { AgentKBHit, AgentKBOptions, kbSearch } from "./agentkb.ts";
import { BudgetTracker } from "./budget.ts";
import {
	createTimelineRecorder,
	formatRunStats,
	type RlmQueryDetails,
	renderRlmCall,
	renderRlmResult,
	TIMELINE_ENTRY_CAP_CHARS,
	TIMELINE_MAX_ENTRIES,
	type TimelineEntry,
	timelineToText,
} from "./index.ts";
import { type CompleteFn, type InvestigatorEvent, runInvestigation } from "./investigator.ts";
import { createRunLogger, LOG_PREVIEW_CAP_CHARS, LOG_TEXT_CAP_CHARS, loggingOnEvent } from "./logging.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { PythonRepl, type RpcHandlers } from "./repl.ts";
import { createRpcHandlers, type LlmOptions, type NestedEvent, type RlmRecursionOptions } from "./rpc.ts";

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

/** kb_search through these options fails fast (nonexistent binary) — used to
 * observe ok:false RPC logging without agentkb. */
const FAILING_KB: AgentKBOptions = {
	pythonPath: "rlm-test6-no-such-python-xyz",
	agentkbCwd: os.tmpdir(),
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

/** kbSearchFn fake returning fixed hits. */
function fakeKbSearch(hits: AgentKBHit[]): KbSearchFn {
	return (async () => hits) as KbSearchFn;
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

function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "rlm-test6-"));
}

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

type LogLine = Record<string, unknown>;

function readEvents(logPath: string): LogLine[] {
	const raw = fs.readFileSync(logPath, "utf8");
	return raw
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as LogLine);
}

function ofEvent(events: LogLine[], name: string): LogLine[] {
	return events.filter((e) => e.event === name);
}

/** Drives one scripted top-level run against a real REPL with the given handlers. */
async function runScripted(
	replies: AssistantMessage[],
	handlers: RpcHandlers,
	onEvent?: (ev: InvestigatorEvent) => void,
	budget?: BudgetTracker,
) {
	const parent = scriptedComplete(replies);
	let result: Awaited<ReturnType<typeof runInvestigation>> | undefined;
	await withRepl(handlers, async (repl) => {
		result = await runInvestigation({
			question: "q",
			systemPrompt: SYSTEM_PROMPT,
			repl,
			model: FAKE_MODEL,
			maxTurns: 10,
			budget: budget ?? new BudgetTracker(10, 1_000),
			outputCapChars: 10_000,
			completeFn: parent.fn,
			onEvent,
		});
	});
	if (!result) throw new Error("runInvestigation produced no result");
	return result;
}

async function main() {
	console.log("Phase 6 Tests\n");
	console.log("--- Logger-level tests ---\n");

	// 1. createRunLogger creates dir + file; distinct run ids
	await run("Logger Creation and Run Ids", async () => {
		const dir = mkTempDir();
		try {
			const logDir = path.join(dir, "logs");
			const a = await createRunLogger(logDir);
			const b = await createRunLogger(logDir);
			assert.ok(fs.existsSync(a.logPath), a.logPath);
			assert.ok(fs.existsSync(b.logPath), b.logPath);
			assert.strictEqual(a.logPath, path.join(logDir, `${a.runId}.ndjson`));
			assert.notStrictEqual(a.runId, b.runId);
			await a.close();
			await b.close();
		} finally {
			rmDir(dir);
		}
	});

	// 2. Event order, valid JSON, shared run id, ts, field round-trip
	await run("Event Order and Round-Trip", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			logger.log({
				inv: "root",
				event: "run_start",
				question: "what is foo?",
				investigator: "azure-foundry/Kimi-K2.6",
				analyst: "azure-foundry/gpt-5.4-nano",
				maxTurns: 12,
				maxDepth: 2,
				maxBudgetUsd: 0.5,
				maxLlmCalls: 100,
				k: 5,
				scope: "wiki",
				contextHits: 3,
			});
			logger.log({ inv: "root", event: "turn_start", turn: 1 });
			logger.log({ inv: "root", event: "run_end", stopReason: "final", turns: 1, costUsd: 0.01 });
			await logger.close();

			const events = readEvents(logger.logPath);
			assert.deepStrictEqual(
				events.map((e) => e.event),
				["run_start", "turn_start", "run_end"],
			);
			for (const e of events) {
				assert.strictEqual(e.run, logger.runId);
				assert.ok(typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)), String(e.ts));
				assert.strictEqual(e.inv, "root");
			}
			const start = events[0] as LogLine;
			assert.strictEqual(start.question, "what is foo?");
			assert.strictEqual(start.investigator, "azure-foundry/Kimi-K2.6");
			assert.strictEqual(start.analyst, "azure-foundry/gpt-5.4-nano");
			assert.strictEqual(start.maxBudgetUsd, 0.5);
			assert.strictEqual(start.contextHits, 3);
			assert.strictEqual("contextNote" in start, false);
		} finally {
			rmDir(dir);
		}
	});

	// 3. Serialized writes under concurrency
	await run("Concurrent Writes Serialize", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			const big = "x".repeat(5_000);
			await Promise.all(
				Array.from({ length: 50 }, (_, i) =>
					(async () => {
						await delay(Math.floor(Math.random() * 10));
						logger.log({ inv: `root.${i}`, event: "assistant_text", turn: i, text: big });
					})(),
				),
			);
			await logger.close();
			const events = readEvents(logger.logPath);
			assert.strictEqual(events.length, 50);
			for (const e of events) {
				assert.strictEqual(e.event, "assistant_text");
				assert.strictEqual((e.text as string).length, big.length);
			}
		} finally {
			rmDir(dir);
		}
	});

	// 4. Central capping of long fields
	await run("Log Field Capping", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			logger.log({ inv: "root", event: "assistant_text", turn: 1, text: "y".repeat(100_000) });
			logger.log({ inv: "root", event: "nested_start", child: "root.1", depth: 1, prompt: "z".repeat(2_000) });
			logger.log({
				inv: "root",
				event: "run_start",
				question: "q".repeat(100_000),
				investigator: "fake/inv",
				analyst: "fake/an",
				maxTurns: 12,
				maxDepth: 2,
				maxBudgetUsd: 0.5,
				maxLlmCalls: 100,
				k: 5,
				scope: "wiki",
				contextHits: 0,
			});
			await logger.close();
			const [textEv, promptEv, startEv] = readEvents(logger.logPath);
			const text = (textEv as LogLine).text as string;
			assert.ok(text.length <= LOG_TEXT_CAP_CHARS + 100, String(text.length));
			assert.ok(text.includes("chars omitted"), text.slice(0, 200));
			const prompt = (promptEv as LogLine).prompt as string;
			assert.ok(prompt.length <= LOG_PREVIEW_CAP_CHARS + 100, String(prompt.length));
			assert.ok(prompt.includes("chars omitted"), prompt.slice(0, 200));
			const question = (startEv as LogLine).question as string;
			assert.ok(question.length <= LOG_TEXT_CAP_CHARS + 100, String(question.length));
			assert.ok(question.includes("chars omitted"), question.slice(0, 200));
		} finally {
			rmDir(dir);
		}
	});

	// 5. Failure degradation: creation throws; mid-run write failure warns once
	await run("Failure Degradation", async () => {
		const dir = mkTempDir();
		try {
			// (a) parent path is a file -> createRunLogger throws (caller degrades).
			const blocker = path.join(dir, "blocker");
			fs.writeFileSync(blocker, "not a directory");
			await assert.rejects(createRunLogger(path.join(blocker, "sub")));

			// (b) write failure after creation: warn once, log() never throws.
			const warns: string[] = [];
			const logDir = path.join(dir, "logs");
			const logger = await createRunLogger(logDir, (msg) => warns.push(msg));
			rmDir(logDir);
			logger.log({ inv: "root", event: "turn_start", turn: 1 });
			logger.log({ inv: "root", event: "turn_start", turn: 2 });
			logger.log({ inv: "root", event: "turn_start", turn: 3 });
			await logger.close();
			assert.strictEqual(warns.length, 1);
			assert.ok(warns[0]?.startsWith("rlm log disabled:"), warns[0]);
			assert.strictEqual(fs.existsSync(logger.logPath), false);
		} finally {
			rmDir(dir);
		}
	});

	// 6. close() flushes; post-close events dropped
	await run("Close Flushes and Drops Late Events", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			for (let i = 1; i <= 20; i++) {
				logger.log({ inv: "root", event: "turn_start", turn: i });
			}
			await logger.close();
			assert.strictEqual(readEvents(logger.logPath).length, 20);
			logger.log({ inv: "root", event: "turn_start", turn: 21 });
			await delay(50);
			assert.strictEqual(readEvents(logger.logPath).length, 20);
		} finally {
			rmDir(dir);
		}
	});

	console.log("\n--- Wiring-level tests ---\n");

	// 7. loggingOnEvent adapter: investigator events logged, done skipped, next unbroken
	await run("loggingOnEvent Adapter", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			const seen: InvestigatorEvent[] = [];
			const result = await runScripted(
				[codeReply("Step.", "print('hi')"), codeReply("Done.", "FINAL('answer')")],
				{},
				loggingOnEvent(logger, "root", (ev) => seen.push(ev)),
			);
			await logger.close();
			assert.strictEqual(result.stopReason, "final");

			const events = readEvents(logger.logPath);
			assert.deepStrictEqual(
				events.map((e) => e.event),
				[
					"turn_start",
					"assistant_text",
					"code_block",
					"exec_result",
					"turn_start",
					"assistant_text",
					"code_block",
					"exec_result",
				],
			);
			for (const e of events) assert.strictEqual(e.inv, "root");
			assert.deepStrictEqual(
				events.map((e) => e.turn),
				[1, 1, 1, 1, 2, 2, 2, 2],
			);
			assert.ok((events[3] as LogLine).text === "stdout:\nhi\n", String(events[3]?.text));
			// next received every event including done.
			assert.deepStrictEqual(
				seen.map((ev) => ev.type),
				[
					"turn_start",
					"assistant_text",
					"code_block",
					"exec_result",
					"turn_start",
					"assistant_text",
					"code_block",
					"exec_result",
					"done",
				],
			);
		} finally {
			rmDir(dir);
		}
	});

	// 8. RPC logging: ok + failure events; behavior unaffected
	await run("RPC Call Logging", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			const analyst = recordingAnalyst("ok");
			const handlers = createRpcHandlers(
				FAILING_KB,
				makeLlm({ completeFn: analyst.fn }),
				makeRlm({ logger, inv: "root" }),
			);
			await withRepl(handlers, async (repl) => {
				const good = await repl.exec("print(llm_query('hello'))");
				assert.strictEqual(good.error, null);
				assert.strictEqual(good.stdout, "ok\n");

				const bad = await repl.exec("kb_search('x')");
				assert.ok(bad.error?.includes("RuntimeError"), `error: ${bad.error}`);
			});
			await logger.close();

			const rpcs = ofEvent(readEvents(logger.logPath), "rpc");
			assert.strictEqual(rpcs.length, 2);
			const [llm, kb] = rpcs as [LogLine, LogLine];
			assert.strictEqual(llm.method, "llm_query");
			assert.strictEqual(llm.ok, true);
			assert.strictEqual(llm.inv, "root");
			assert.ok(typeof llm.durationMs === "number" && llm.durationMs >= 0, String(llm.durationMs));
			assert.ok((llm.argsPreview as string).includes("hello"), String(llm.argsPreview));
			assert.ok((llm.resultPreview as string).includes("ok"), String(llm.resultPreview));
			assert.strictEqual(llm.resultChars, 2);
			assert.strictEqual(kb.method, "kb_search");
			assert.strictEqual(kb.ok, false);
			assert.ok(typeof kb.error === "string" && kb.error.length > 0, String(kb.error));
			assert.strictEqual("resultPreview" in kb, false);
		} finally {
			rmDir(dir);
		}
	});

	// 9. Nested run logging: lifecycle, child inv ids in call order, child turn events
	await run("Nested Run Logging", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			const stats = { nestedRuns: 0 };
			const childFn = (async () => codeReply("Child.", "FINAL('child')", 0.001)) as CompleteFn;
			const handlers = createRpcHandlers(
				FAILING_KB,
				makeLlm({}),
				makeRlm({ completeFn: childFn, kbSearchFn: fakeKbSearch([]), stats, logger, inv: "root" }),
			);
			const result = await runScripted(
				[
					codeReply("Recurse.", "a = rlm_query('sub one')\nb = rlm_query('sub two')"),
					codeReply("Done.", "FINAL(a + ' ' + b)"),
				],
				handlers,
				loggingOnEvent(logger, "root"),
			);
			await logger.close();
			assert.strictEqual(result.stopReason, "final");
			assert.strictEqual(result.answer, "child child");
			assert.strictEqual(stats.nestedRuns, 2);

			const events = readEvents(logger.logPath);
			const runIds = new Set(events.map((e) => e.run));
			assert.strictEqual(runIds.size, 1);

			const starts = ofEvent(events, "nested_start");
			assert.deepStrictEqual(
				starts.map((e) => [e.inv, e.child, e.depth, e.prompt]),
				[
					["root", "root.1", 1, "sub one"],
					["root", "root.2", 1, "sub two"],
				],
			);
			const ends = ofEvent(events, "nested_end");
			assert.deepStrictEqual(
				ends.map((e) => [e.inv, e.child, e.stopReason, e.turns]),
				[
					["root", "root.1", "final", 1],
					["root", "root.2", "final", 1],
				],
			);
			for (const child of ["root.1", "root.2"]) {
				const childEvents = events.filter((e) => e.inv === child);
				assert.deepStrictEqual(
					childEvents.map((e) => e.event),
					["turn_start", "assistant_text", "code_block", "exec_result"],
					child,
				);
				assert.ok((childEvents[1] as LogLine).text === "Child.\n\n```python\nFINAL('child')\n```", child);
			}
			const rpcs = ofEvent(events, "rpc").filter((e) => e.method === "rlm_query");
			assert.strictEqual(rpcs.length, 2);
			for (const r of rpcs) {
				assert.strictEqual(r.ok, true);
				assert.strictEqual(r.inv, "root");
			}
			assert.strictEqual(ofEvent(events, "downgrade").length, 0);
		} finally {
			rmDir(dir);
		}
	});

	// 10. Downgrade logging: downgrade event, no nested_start
	await run("Downgrade Logging", async () => {
		const dir = mkTempDir();
		try {
			const logger = await createRunLogger(dir);
			const child = throwingComplete("child investigator");
			const analyst = recordingAnalyst("downgraded");
			const handlers = createRpcHandlers(
				FAILING_KB,
				makeLlm({ completeFn: analyst.fn }),
				makeRlm({ depth: 2, maxDepth: 2, completeFn: child.fn, logger, inv: "root.1.1" }),
			);
			await withRepl(handlers, async (repl) => {
				const res = await repl.exec("print(rlm_query('deep question'))");
				assert.strictEqual(res.error, null);
				assert.strictEqual(res.stdout, "downgraded\n");
			});
			await logger.close();
			assert.strictEqual(child.called(), false);

			const events = readEvents(logger.logPath);
			const downgrades = ofEvent(events, "downgrade");
			assert.strictEqual(downgrades.length, 1);
			assert.strictEqual(downgrades[0]?.inv, "root.1.1");
			assert.strictEqual(downgrades[0]?.depth, 2);
			assert.strictEqual(downgrades[0]?.prompt, "deep question");
			assert.strictEqual(ofEvent(events, "nested_start").length, 0);
			// The analyst call is visible as the parent's rlm_query rpc event.
			const rpcs = ofEvent(events, "rpc").filter((e) => e.method === "rlm_query");
			assert.strictEqual(rpcs.length, 1);
			assert.strictEqual(rpcs[0]?.ok, true);
		} finally {
			rmDir(dir);
		}
	});

	// 11. No-logger paths behave identically and create no files
	await run("No-Logger Optionality", async () => {
		const dir = mkTempDir();
		try {
			// Test-7 scenario without a logger.
			const seen: InvestigatorEvent[] = [];
			const r1 = await runScripted(
				[codeReply("Step.", "print('hi')"), codeReply("Done.", "FINAL('answer')")],
				{},
				loggingOnEvent(undefined, "root", (ev) => seen.push(ev)),
			);
			assert.strictEqual(r1.stopReason, "final");
			assert.strictEqual(r1.answer, "answer");
			assert.strictEqual(seen.filter((ev) => ev.type === "done").length, 1);

			// Test-9 scenario without a logger.
			const stats = { nestedRuns: 0 };
			const nestedEvents: NestedEvent[] = [];
			const childFn = (async () => codeReply("Child.", "FINAL('child')", 0.001)) as CompleteFn;
			const handlers = createRpcHandlers(
				FAILING_KB,
				makeLlm({}),
				makeRlm({
					completeFn: childFn,
					kbSearchFn: fakeKbSearch([]),
					stats,
					onNested: (ev) => nestedEvents.push(ev),
				}),
			);
			const r2 = await runScripted(
				[
					codeReply("Recurse.", "a = rlm_query('sub one')\nb = rlm_query('sub two')"),
					codeReply("Done.", "FINAL(a + ' ' + b)"),
				],
				handlers,
			);
			assert.strictEqual(r2.stopReason, "final");
			assert.strictEqual(r2.answer, "child child");
			assert.strictEqual(stats.nestedRuns, 2);
			assert.strictEqual(nestedEvents.length, 4);
			assert.strictEqual(fs.readdirSync(dir).length, 0);
		} finally {
			rmDir(dir);
		}
	});

	console.log("\n--- Formatter / detail-level tests ---\n");

	// 12. Timeline recorder: kinds, caps, overflow drop
	await run("Timeline Recorder", async () => {
		let changes = 0;
		const rec = createTimelineRecorder(() => changes++);
		rec.onEvent({ type: "turn_start", turn: 1 });
		rec.onEvent({ type: "assistant_text", turn: 1, text: "hello" });
		rec.onEvent({ type: "code_block", turn: 1, text: "print(1)" }); // not recorded
		rec.onEvent({ type: "exec_result", turn: 1, text: "out" });
		rec.onNested({ phase: "start", depth: 1, prompt: "p".repeat(200) });
		rec.onNested({ phase: "end", depth: 1, prompt: "p", stopReason: "final", turns: 2 });
		rec.onEvent({ type: "done", turn: 1 }); // not recorded
		rec.note("[a note]");

		assert.strictEqual(changes, 6);
		assert.strictEqual(rec.lastTurn(), 1);
		const entries = rec.entries();
		assert.deepStrictEqual(
			entries.map((e) => e.kind),
			["turn", "assistant", "exec", "nested_start", "nested_end", "note"],
		);
		assert.strictEqual(entries[0]?.text, "--- turn 1 ---");
		assert.strictEqual(entries[0]?.turn, 1);
		assert.ok(entries[3]?.text.startsWith("[depth 1 rlm_query started: "), entries[3]?.text);
		assert.ok(entries[3]?.text.includes("..."), entries[3]?.text); // 200-char prompt previewed
		assert.strictEqual(entries[3]?.depth, 1);
		assert.strictEqual(entries[4]?.text, "[depth 1 rlm_query finished: final, 2 turns]");

		// Per-entry cap.
		rec.onEvent({ type: "assistant_text", turn: 2, text: "x".repeat(10_000) });
		const capped = rec.entries().at(-1) as TimelineEntry;
		assert.ok(capped.text.length <= TIMELINE_ENTRY_CAP_CHARS + 100, String(capped.text.length));
		assert.ok(capped.text.includes("chars omitted"), capped.text.slice(0, 100));

		// Overflow: oldest entries drop, one note marker is prepended.
		const pushedSoFar = 7;
		const extra = 300;
		for (let i = 0; i < extra; i++) rec.note(`note ${i}`);
		const all = rec.entries();
		assert.strictEqual(all.length, TIMELINE_MAX_ENTRIES);
		const expectedDropped = pushedSoFar + extra - (TIMELINE_MAX_ENTRIES - 1);
		assert.strictEqual(all[0]?.text, `[... ${expectedDropped} earlier entries dropped]`);
		assert.strictEqual(all[0]?.kind, "note");
		assert.strictEqual(all.at(-1)?.text, `note ${extra - 1}`);
	});

	// 13. timelineToText matches the transcript format
	await run("timelineToText Format", async () => {
		const entries: TimelineEntry[] = [
			{ kind: "turn", turn: 1, text: "--- turn 1 ---" },
			{ kind: "assistant", turn: 1, text: "Prose." },
			{ kind: "exec", turn: 1, text: "stdout:\nhi" },
			{ kind: "nested_start", depth: 1, text: "[depth 1 rlm_query started: p]" },
		];
		assert.strictEqual(
			timelineToText(entries),
			"--- turn 1 ---\n\nProse.\n\nstdout:\nhi\n\n[depth 1 rlm_query started: p]",
		);
		assert.strictEqual(timelineToText([]), "");
	});

	// 14. formatRunStats
	await run("formatRunStats", async () => {
		const full: RlmQueryDetails = {
			stopReason: "final",
			turns: 5,
			modelCalls: 23,
			costUsd: 0.0841,
			nestedRuns: 2,
			contextHits: 5,
			timeline: [],
		};
		assert.strictEqual(formatRunStats(full), "final · 5 turns · 23 calls · $0.0841 · 2 nested · 5 ctx hits");
		const minimal: RlmQueryDetails = { turns: 1, contextHits: 1, timeline: [] };
		assert.strictEqual(formatRunStats(minimal), "1 turn · 1 ctx hit");
	});

	// 15. Render smoke: renderCall / renderResult with a passthrough theme
	await run("Render Smoke", async () => {
		initTheme("dark"); // getMarkdownTheme() in the expanded view needs the global theme
		const stub = {
			fg: (_color: unknown, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const renderText = (component: { render: (width: number) => string[] }) => component.render(200).join("\n");

		const call = renderText(renderRlmCall({ prompt: "What does the wiki say about Foo?", k: 8 }, stub));
		assert.ok(call.includes("rlm_query"), call);
		assert.ok(call.includes("What does the wiki say about Foo?"), call);
		assert.ok(call.includes("k=8"), call);
		assert.ok(!call.includes("scope="), call);
		const defaultCall = renderText(renderRlmCall({ prompt: "Q" }, stub));
		assert.ok(!defaultCall.includes("["), defaultCall);

		const details: RlmQueryDetails = {
			stopReason: "final",
			turns: 2,
			modelCalls: 3,
			costUsd: 0.0123,
			contextHits: 4,
			nestedRuns: 1,
			runId: "20260612-100000-abcd",
			logPath: "C:\\logs\\20260612-100000-abcd.ndjson",
			timeline: [
				{ kind: "turn", turn: 1, text: "--- turn 1 ---" },
				{ kind: "assistant", turn: 1, text: "Investigating the wiki." },
				{ kind: "nested_start", depth: 1, text: "[depth 1 rlm_query started: sub]" },
			],
		};
		const result: AgentToolResult<RlmQueryDetails | undefined> = {
			content: [{ type: "text", text: "The Foo pipeline deploys nightly.\nSecond line." }],
			details,
		};

		const collapsed = renderText(renderRlmResult(result, { expanded: false, isPartial: false }, stub));
		assert.ok(collapsed.includes("final · 2 turns · 3 calls · $0.0123 · 1 nested · 4 ctx hits"), collapsed);
		assert.ok(collapsed.includes("The Foo pipeline deploys nightly."), collapsed);
		assert.ok(collapsed.includes("(Ctrl+O to expand)"), collapsed);
		assert.ok(collapsed.includes("✓"), collapsed);

		const partial = renderText(
			renderRlmResult(
				{ content: [{ type: "text", text: "" }], details: { ...details, stopReason: undefined } },
				{ expanded: false, isPartial: true },
				stub,
			),
		);
		assert.ok(partial.includes("investigating"), partial);
		assert.ok(partial.includes("turn 2"), partial);
		assert.ok(partial.includes("1 nested"), partial);
		assert.ok(partial.includes("[depth 1 rlm_query started: sub]"), partial);

		const expanded = renderText(renderRlmResult(result, { expanded: true, isPartial: false }, stub));
		assert.ok(expanded.includes("─── Investigation ───"), expanded);
		assert.ok(expanded.includes("--- turn 1 ---"), expanded);
		assert.ok(expanded.includes("─── Answer ───"), expanded);
		assert.ok(expanded.includes("The Foo pipeline deploys nightly."), expanded);
		assert.ok(expanded.includes("20260612-100000-abcd.ndjson"), expanded);

		const fallback = renderText(
			renderRlmResult(
				{ content: [{ type: "text", text: "plain answer" }], details: undefined },
				{
					expanded: false,
					isPartial: false,
				},
				stub,
			),
		);
		assert.strictEqual(fallback.trim(), "plain answer");

		// Warning and error stop reasons pick the right icon.
		const warn = renderText(
			renderRlmResult(
				{ content: [{ type: "text", text: "partial" }], details: { ...details, stopReason: "budget" } },
				{ expanded: false, isPartial: false },
				stub,
			),
		);
		assert.ok(warn.includes("◐"), warn);
		const err = renderText(
			renderRlmResult(
				{ content: [{ type: "text", text: "boom" }], details: { ...details, stopReason: "error" } },
				{ expanded: false, isPartial: false },
				stub,
			),
		);
		assert.ok(err.includes("✗"), err);
	});

	console.log("\nDone.");
	if (unhandledRejections > 0) {
		console.error(`${unhandledRejections} unhandled rejection(s)`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
