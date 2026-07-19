import * as assert from "node:assert";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_AGENTKB_CWD, DEFAULT_AGENTKB_PYTHON } from "./agentkb.ts";
import { BudgetTracker } from "./budget.ts";
import type { CompleteFn } from "./investigator.ts";
import { PythonRepl } from "./repl.ts";
import { createRpcHandlers } from "./rpc.ts";

// Real agentkb integration tests. Require the local corporate setup:
//   C:\Appl\workspace\Python\agentkb  +  venv\Scripts\python.exe  +  indexed KB content.
// Gated behind RLM_AGENTKB_TESTS=1; not part of any CI suite.

if (process.env.RLM_AGENTKB_TESTS !== "1") {
	console.log("Skipping agentkb integration tests (set RLM_AGENTKB_TESTS=1 to run).");
	process.exit(0);
}

function timeout(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		const t = setTimeout(() => reject(new Error("Test timeout")), ms);
		t.unref();
	});
}

async function run(name: string, fn: () => Promise<void>) {
	try {
		await Promise.race([fn(), timeout(60_000)]);
		console.log(`PASS: ${name}`);
	} catch (err) {
		console.error(`FAIL: ${name}`);
		console.error(err);
		process.exitCode = 1;
	}
}

// These tests only exercise the KB builtins; the analyst stub fails loudly if reached.
const STUB_ANALYST_MODEL: Model<Api> = {
	id: "stub-analyst",
	name: "Stub Analyst",
	api: "openai-completions",
	provider: "stub",
	baseUrl: "http://localhost:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

const stubCompleteFn = (async () => {
	throw new Error("llm_query is not under test in the agentkb integration suite");
}) as CompleteFn;

const stubChildCompleteFn = (async () => {
	throw new Error("rlm_query is not under test in the agentkb integration suite");
}) as CompleteFn;

async function withRepl(fn: (repl: PythonRepl) => Promise<void>) {
	const repl = new PythonRepl({ pythonPath: DEFAULT_AGENTKB_PYTHON });
	repl.setRpcHandlers(
		createRpcHandlers(
			{
				pythonPath: DEFAULT_AGENTKB_PYTHON,
				agentkbCwd: DEFAULT_AGENTKB_CWD,
			},
			{ model: STUB_ANALYST_MODEL, budget: new BudgetTracker(0, 0), completeFn: stubCompleteFn },
			{
				// maxDepth 0: nothing recurses in this suite.
				depth: 0,
				maxDepth: 0,
				replPythonPath: DEFAULT_AGENTKB_PYTHON,
				maxTurns: 4,
				outputCapChars: 10_000,
				k: 5,
				scope: "wiki",
				completeFn: stubChildCompleteFn,
			},
		),
	);
	try {
		await repl.ready();
		await fn(repl);
	} finally {
		await repl.close();
	}
}

async function main() {
	console.log("Phase 2 Tests (real agentkb)\n");

	// 1+2. kb_search returns an array; valid hits contain a usable path
	await run("kb_search Returns Hits With Paths", async () => {
		await withRepl(async (repl) => {
			const code = [
				"hits = kb_search('installation', k=2)",
				"print(type(hits).__name__)",
				"print(len(hits))",
				"for h in hits:",
				"    assert isinstance(h.get('path'), str) and h['path'].strip(), h",
				"print('paths ok')",
			].join("\n");
			const res = await repl.exec(code);
			assert.strictEqual(res.error, null, res.error ?? "");
			const lines = res.stdout.trim().split("\n");
			assert.strictEqual(lines[0], "list");
			assert.strictEqual(lines[lines.length - 1], "paths ok");
		});
	});

	// 3. kb_read on first hit returns non-empty text
	await run("kb_read Returns Text", async () => {
		await withRepl(async (repl) => {
			const code = [
				"hits = kb_search('installation', k=2)",
				"if not hits:",
				"    print('NO HITS')",
				"else:",
				"    text = kb_read(hits[0]['path'])",
				"    print('chars', len(text))",
				"    assert len(text) > 0",
			].join("\n");
			const res = await repl.exec(code);
			assert.strictEqual(res.error, null, res.error ?? "");
			assert.ok(res.stdout.includes("chars") || res.stdout.includes("NO HITS"), res.stdout);
		});
	});

	// 4. Invalid scope surfaces a clean error
	await run("Invalid Scope Error", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("kb_search('installation', k=1, scope='no_such_scope_xyz')");
			assert.ok(res.error?.includes("RuntimeError"), `error: ${res.error}`);
		});
	});

	// 5. Nonexistent read path surfaces a clean error
	await run("Nonexistent Read Path Error", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(`kb_read(r'${DEFAULT_AGENTKB_CWD}\\does\\not\\exist.md')`);
			assert.ok(res.error?.includes("RuntimeError"), `error: ${res.error}`);
		});
	});

	// 6. Path outside configured root is rejected
	await run("Read Outside Root Rejected", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("kb_read(r'C:\\Windows\\win.ini')");
			assert.ok(res.error?.includes("outside the configured agentkb root"), `error: ${res.error}`);
		});
	});

	// 7. Compound block: kb_search followed by kb_read
	await run("Compound Search Then Read", async () => {
		await withRepl(async (repl) => {
			const code = [
				"results = kb_search('installation', k=2)",
				"print('hits', len(results))",
				"if results:",
				"    text = kb_read(results[0]['path'])",
				"    print('read', len(text) > 0)",
			].join("\n");
			const res = await repl.exec(code);
			assert.strictEqual(res.error, null, res.error ?? "");
			assert.ok(res.stdout.startsWith("hits "), res.stdout);
		});
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
