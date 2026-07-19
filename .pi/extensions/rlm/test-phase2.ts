import * as assert from "node:assert";
import { PythonRepl, type RpcHandlers } from "./repl.ts";

const PYTHON = process.env.RLM_PYTHON ?? "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

const MOCK_HIT_PATH = "C:\\Appl\\workspace\\Python\\agentkb\\wiki\\mock.md";

function mockHandlers(): RpcHandlers {
	return {
		kb_search: async () => [
			{
				path: MOCK_HIT_PATH,
				score: 1,
				title: "Mock Result",
			},
		],
		kb_read: async () => "Mock file content",
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
		await Promise.race([fn(), timeout(15_000)]);
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
	console.log("Phase 2 Tests (mock RPC handlers)\n");

	// 1. Host boots and exposes the phase marker (advances with later phases)
	await run("Host Phase Marker", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("print(_RLM_HOST_PHASE)");
			assert.strictEqual(res.stdout, "5\n");
			assert.strictEqual(res.error, null);
		});
	});

	// 2. Host exposes _RLM_BUILTINS containing kb_search and kb_read
	await run("Host Builtins Marker", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("print('kb_search' in _RLM_BUILTINS, 'kb_read' in _RLM_BUILTINS)");
			assert.strictEqual(res.stdout, "True True\n");
			assert.strictEqual(res.error, null);
		});
	});

	// 3. kb_search returns a list from the mock handler
	await run("kb_search via Mock Handler", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(
				"hits = kb_search('test', k=2)\nprint(type(hits).__name__, len(hits))\nprint(hits[0]['path'])\nprint(hits[0]['title'])",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, `list 1\n${MOCK_HIT_PATH}\nMock Result\n`);
		});
	});

	// 4. kb_read returns a string from the mock handler
	await run("kb_read via Mock Handler", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("text = kb_read('whatever')\nprint(type(text).__name__)\nprint(text)");
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "str\nMock file content\n");
		});
	});

	// 5. Multiple sequential RPC calls in one exec
	await run("Multiple Sequential RPC Calls", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(
				"a = kb_search('one')\nb = kb_search('two')\nc = kb_read(a[0]['path'])\nprint(len(a), len(b), len(c))",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "1 1 17\n");
		});
	});

	// 6. Stdout ordering around RPC calls
	await run("Stdout Ordering Around RPC", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec(
				"print('before')\nhits = kb_search('mock', k=1)\nprint('middle', len(hits))\ntext = kb_read(hits[0]['path'])\nprint('after', text[:4])",
			);
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "before\nmiddle 1\nafter Mock\n");
		});
	});

	// 7. RPC handler throws -> Python traceback with RuntimeError
	await run("RPC Handler Error Becomes Traceback", async () => {
		await withRepl(
			async (repl) => {
				const res = await repl.exec("kb_search('boom')");
				assert.strictEqual(res.stdout, "");
				assert.ok(res.error?.includes("RuntimeError"), `error missing RuntimeError: ${res.error}`);
				assert.ok(res.error?.includes("mock handler failure"), `error missing message: ${res.error}`);
				// host survives
				const res2 = await repl.exec("print('still alive')");
				assert.strictEqual(res2.stdout, "still alive\n");
			},
			{
				...mockHandlers(),
				kb_search: async () => {
					throw new Error("mock handler failure");
				},
			},
		);
	});

	// 8. Unknown RPC method returns a Python-visible error
	await run("Unknown RPC Method", async () => {
		// Only kb_search is registered; kb_read becomes an unknown method on the TS side.
		await withRepl(
			async (repl) => {
				const res = await repl.exec("kb_read('x')");
				assert.ok(res.error?.includes("Unknown RPC method: kb_read"), `error: ${res.error}`);
				const res2 = await repl.exec("print('still alive')");
				assert.strictEqual(res2.stdout, "still alive\n");
			},
			{ kb_search: mockHandlers().kb_search },
		);
	});

	// 9. Concurrent exec is still rejected while one exec is active (incl. during RPC)
	await run("Concurrent Exec Guard During RPC", async () => {
		const slowHandlers: RpcHandlers = {
			...mockHandlers(),
			kb_search: async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return [];
			},
		};
		await withRepl(async (repl) => {
			const p1 = repl.exec("hits = kb_search('slow')\nprint('done', len(hits))");
			await new Promise((resolve) => setTimeout(resolve, 100));
			await assert.rejects(repl.exec("print('nope')"), /one exec allowed at a time/);
			const res = await p1;
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "done 0\n");
		}, slowHandlers);
	});

	// 10. RPC timeout returns a Python-visible error
	await run("RPC Timeout", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON, rpcTimeoutMs: 300 });
		repl.setRpcHandlers({
			kb_search: () => new Promise(() => {}),
		});
		try {
			await repl.ready();
			const res = await repl.exec("kb_search('hang')");
			assert.ok(res.error?.includes("timed out after 300ms"), `error: ${res.error}`);
			const res2 = await repl.exec("print('still alive')");
			assert.strictEqual(res2.stdout, "still alive\n");
		} finally {
			await repl.close();
		}
	});

	// 11. input() is disabled
	await run("input() Disabled", async () => {
		await withRepl(async (repl) => {
			const res = await repl.exec("input('prompt')");
			assert.ok(res.error?.includes("input() is disabled in the RLM REPL host"), `error: ${res.error}`);
		});
	});

	// 12. RPC from non-main thread raises the main-thread guard error
	await run("Main-Thread-Only RPC Guard", async () => {
		await withRepl(async (repl) => {
			const code = [
				"import threading",
				"errors = []",
				"def worker():",
				"    try:",
				"        kb_search('from thread')",
				"    except RuntimeError as e:",
				"        errors.append(str(e))",
				"t = threading.Thread(target=worker)",
				"t.start()",
				"t.join()",
				"print(errors[0])",
			].join("\n");
			const res = await repl.exec(code);
			assert.strictEqual(res.error, null);
			assert.ok(res.stdout.includes("RPC builtins may only be called from the main REPL thread"), res.stdout);
		});
	});

	// 13. ready() during a running exec resolves instead of arming a startup timeout
	await run("ready() During Exec", async () => {
		await withRepl(async (repl) => {
			const p1 = repl.exec("import time\ntime.sleep(0.5)\nprint('done')");
			await new Promise((resolve) => setTimeout(resolve, 100));
			await repl.ready();
			const res = await p1;
			assert.strictEqual(res.error, null);
			assert.strictEqual(res.stdout, "done\n");
		});
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
