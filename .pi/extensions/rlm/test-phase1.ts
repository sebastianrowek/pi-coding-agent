import * as assert from "node:assert";
import { PythonRepl } from "./repl.ts";

const PYTHON = process.env.RLM_PYTHON ?? "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

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

async function main() {
	console.log("Phase 1 Tests\n");

	// 1. Spawn and Ready
	await run("Spawn and Ready", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		assert.strictEqual(typeof repl.close, "function");
		await repl.close();
	});

	// 2. Simple Exec
	await run("Simple Exec", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("print('hello')");
		assert.strictEqual(res.stdout, "hello\n");
		assert.strictEqual(res.stderr, "");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 3. Namespace Persistence
	await run("Namespace Persistence", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.exec("x = 42");
		const res = await repl.exec("print(x)");
		assert.strictEqual(res.stdout, "42\n");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 4. Function Persistence
	await run("Function Persistence", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.exec("def add(a, b):\n    return a + b");
		const res = await repl.exec("print(add(2, 3))");
		assert.strictEqual(res.stdout, "5\n");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 5. Import Persistence
	await run("Import Persistence", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.exec("import math");
		const res = await repl.exec("print(math.sqrt(16))");
		assert.strictEqual(res.stdout, "4.0\n");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 6. Exception Handling
	await run("Exception Handling", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("1 / 0");
		assert.strictEqual(res.stdout, "");
		assert.strictEqual(res.stderr, "");
		assert.ok(res.error?.includes("ZeroDivisionError"));
		// host should still be alive
		const res2 = await repl.exec("print('still alive')");
		assert.strictEqual(res2.stdout, "still alive\n");
		await repl.close();
	});

	// 7. Host Survives SystemExit
	await run("Host Survives SystemExit", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("raise SystemExit(3)");
		assert.ok(res.error?.includes("SystemExit"));
		const res2 = await repl.exec("print('still alive')");
		assert.strictEqual(res2.stdout, "still alive\n");
		await repl.close();
	});

	// 8. Stderr Capture
	await run("Stderr Capture", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("import sys\nsys.stderr.write('oops')");
		assert.strictEqual(res.stdout, "");
		assert.strictEqual(res.stderr, "oops");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 9. Large Stdout
	await run("Large Stdout", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("print('x' * 100000)");
		assert.strictEqual(res.stdout.length, 100001); // 100000 + newline
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 10. JSON-looking Stdout
	await run("JSON-looking Stdout", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec('print(\'{"type":"ready"}\')\nprint(\'{"type":"result","stdout":"fake"}\')');
		assert.ok(res.stdout.includes('{"type":"ready"}'));
		assert.ok(res.stdout.includes('{"type":"result","stdout":"fake"}'));
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 11. Unicode Output
	await run("Unicode Output", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("print('äöü ß 😀')");
		assert.strictEqual(res.stdout, "äöü ß 😀\n");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 12. Multiline Code and Output
	await run("Multiline Code and Output", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("for i in range(3):\n    print(f'line {i}')");
		assert.strictEqual(res.stdout, "line 0\nline 1\nline 2\n");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 13. Expression Behavior
	await run("Expression Behavior", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res = await repl.exec("2 + 2");
		assert.strictEqual(res.stdout, "");
		assert.strictEqual(res.stderr, "");
		assert.strictEqual(res.error, null);
		await repl.close();
	});

	// 14. Request ID Matching
	await run("Request ID Matching", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const res1 = await repl.exec("print('first')");
		assert.strictEqual(res1.stdout, "first\n");
		const res2 = await repl.exec("print('second')");
		assert.strictEqual(res2.stdout, "second\n");
		await repl.close();
	});

	// 15. Concurrent Exec Guard
	await run("Concurrent Exec Guard", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		const p1 = repl.exec("import time\ntime.sleep(1)\nprint('done')");
		const p2 = repl.exec("print('nope')");
		await assert.rejects(p2, /one exec allowed at a time/);
		await p1; // should still resolve
		await repl.close();
	});

	// 16. Exec Timeout
	await run("Exec Timeout", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON, execTimeoutMs: 500 });
		await repl.ready();
		await assert.rejects(repl.exec("while True:\n    pass"), /timeout/i);
		await assert.rejects(repl.exec("print('nope')"), /closed|failed|not running/);
		await repl.close();
	});

	// 17. Graceful Close
	await run("Graceful Close", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.close();
	});

	// 18. Double Close
	await run("Double Close", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.close();
		await repl.close();
	});

	// 19. Exec After Close
	await run("Exec After Close", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON });
		await repl.ready();
		await repl.close();
		await assert.rejects(repl.exec("print('nope')"), /closed/);
	});

	// 20. Startup Failure Diagnostics
	await run("Startup Failure Diagnostics", async () => {
		const repl = new PythonRepl({ pythonPath: PYTHON, hostPath: "C:\\nonexistent\\host.py" });
		await assert.rejects(repl.ready(), /exited|failed|error/i);
		await repl.close();
	});

	// 21. Invalid Python Path
	await run("Invalid Python Path", async () => {
		const repl = new PythonRepl({ pythonPath: "C:\\nonexistent\\python.exe" });
		await assert.rejects(repl.ready(), /python|nonexistent|failed|error/i);
		await repl.close();
	});

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
