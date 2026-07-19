import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ExecResult {
	stdout: string;
	stderr: string;
	error?: string | null;
	final?: string | null;
}

export interface PythonReplOptions {
	pythonPath: string;
	hostPath?: string;
	cwd?: string;
	startupTimeoutMs?: number;
	execTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	rpcTimeoutMs?: number;
	signal?: AbortSignal;
}

export type RpcHandler = (args: unknown) => Promise<unknown> | unknown;

export interface RpcHandlerEntry {
	handler: RpcHandler;
	/** Overrides options.rpcTimeoutMs for this method. */
	timeoutMs?: number;
}

export type RpcHandlers = Record<string, RpcHandler | RpcHandlerEntry>;

type ReplState = "starting" | "ready" | "executing" | "closed" | "failed";

const MAX_DIAGNOSTIC_CHARS = 20_000;
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));

export class PythonRepl {
	private options: Required<
		Pick<PythonReplOptions, "startupTimeoutMs" | "execTimeoutMs" | "shutdownTimeoutMs" | "rpcTimeoutMs">
	> &
		PythonReplOptions;
	private proc: ChildProcess | null = null;
	private state: ReplState = "starting";
	private nextId = 1;
	private pendingExec: {
		id: number;
		resolve: (result: ExecResult) => void;
		reject: (err: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
	private readyDeferred: {
		resolve: () => void;
		reject: (err: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
	private stderrBuffer = "";
	private stdoutBuffer = "";
	private abortHandler: (() => void) | null = null;
	private closePromise: Promise<void> | null = null;
	private closeResolve: (() => void) | null = null;
	private rpcHandlers: Record<string, RpcHandlerEntry> = {};

	constructor(options: PythonReplOptions) {
		this.options = {
			startupTimeoutMs: 10_000,
			execTimeoutMs: 120_000,
			shutdownTimeoutMs: 2_000,
			rpcTimeoutMs: 60_000,
			...options,
		};
		this.spawn();
	}

	setRpcHandlers(handlers: RpcHandlers): void {
		const normalized: Record<string, RpcHandlerEntry> = {};
		for (const [method, entry] of Object.entries(handlers)) {
			normalized[method] = typeof entry === "function" ? { handler: entry } : entry;
		}
		this.rpcHandlers = normalized;
	}

	private spawn(): void {
		// addEventListener("abort") never fires for an already-aborted signal, so
		// without this guard a post-Esc construction (e.g. a not-yet-launched
		// batched sibling) would spawn a process that only dies on close().
		if (this.options.signal?.aborted) {
			this.state = "failed";
			return;
		}

		const pythonPath = this.options.pythonPath;
		const hostPath = this.options.hostPath ?? path.join(EXT_DIR, "host.py");

		try {
			this.proc = spawn(pythonPath, ["-u", hostPath], {
				cwd: this.options.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			this.state = "failed";
			if (this.readyDeferred) {
				this.readyDeferred.reject(err instanceof Error ? err : new Error(String(err)));
				this.clearReadyTimeout();
				this.readyDeferred = null;
			}
			return;
		}

		this.closePromise = new Promise((resolve) => {
			this.closeResolve = resolve;
		});

		if (this.options.signal) {
			this.abortHandler = () => {
				this.fail(new Error("Aborted"));
			};
			this.options.signal.addEventListener("abort", this.abortHandler);
		}

		this.proc.stdout!.on("data", (data: Buffer) => {
			this.stdoutBuffer += data.toString("utf-8");
			const lines = this.stdoutBuffer.split("\n");
			this.stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line) this.handleLine(line);
			}
		});

		this.proc.stderr!.on("data", (data: Buffer) => {
			const text = data.toString("utf-8");
			this.stderrBuffer += text;
			if (this.stderrBuffer.length > MAX_DIAGNOSTIC_CHARS) {
				this.stderrBuffer = this.stderrBuffer.slice(-MAX_DIAGNOSTIC_CHARS);
			}
		});

		this.proc.on("close", (code, signal) => {
			if (this.state === "closed") {
				this.finishClose();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			this.fail(new Error(`Python process exited (${reason})`));
		});

		this.proc.on("error", (err) => {
			if (this.state === "closed") {
				this.finishClose();
				return;
			}
			this.fail(err);
		});
	}

	private handleLine(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			this.fail(new Error(`Protocol parse error: ${line.slice(0, 200)}`));
			return;
		}

		const type = msg.type;
		if (type === "ready") {
			if (this.state === "starting") {
				this.state = "ready";
				if (this.readyDeferred) {
					this.clearReadyTimeout();
					this.readyDeferred.resolve();
					this.readyDeferred = null;
				}
			}
			return;
		}

		if (type === "rpc") {
			if (!this.pendingExec) {
				this.fail(new Error("Received RPC message with no pending exec"));
				return;
			}
			const rpcId = msg.id;
			if (typeof rpcId !== "number" || !Number.isInteger(rpcId)) {
				this.fail(new Error(`Malformed RPC message: id must be an integer, got ${JSON.stringify(rpcId)}`));
				return;
			}
			const method = msg.method;
			if (typeof method !== "string" || !method) {
				this.fail(new Error(`Malformed RPC message: method must be a non-empty string`));
				return;
			}
			const args = msg.args ?? {};
			// Time spent in a TypeScript RPC handler is not Python compute time:
			// suspend the exec timeout until the response is written, so a block
			// whose RPCs take longer than execTimeoutMs is not killed.
			this.clearExecTimeout();
			void this.handleRpcMessage(rpcId, method, args);
			return;
		}

		if (type === "result") {
			if (!this.pendingExec) {
				this.fail(new Error(`Unexpected result with no pending exec`));
				return;
			}
			const resultId = msg.id;
			if (resultId !== this.pendingExec.id) {
				this.fail(new Error(`Result ID mismatch: expected ${this.pendingExec.id}, got ${resultId}`));
				return;
			}
			this.clearExecTimeout();
			this.state = "ready";
			const resolve = this.pendingExec.resolve;
			this.pendingExec = null;
			resolve({
				stdout: String(msg.stdout ?? ""),
				stderr: String(msg.stderr ?? ""),
				error: typeof msg.error === "string" ? msg.error : null,
				final: typeof msg.final === "string" ? msg.final : null,
			});
			return;
		}

		this.fail(new Error(`Unknown protocol message type: ${type}`));
	}

	private async handleRpcMessage(rpcId: number, method: string, args: unknown): Promise<void> {
		const entry = this.rpcHandlers[method];
		if (!entry) {
			this.writeRpcResponse({ type: "rpc_response", id: rpcId, ok: false, error: `Unknown RPC method: ${method}` });
			this.rearmExecTimeout();
			return;
		}

		const timeoutMs = entry.timeoutMs ?? this.options.rpcTimeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		try {
			const value = await Promise.race([Promise.resolve(entry.handler(args)), timeoutPromise]);
			this.writeRpcResponse({ type: "rpc_response", id: rpcId, ok: true, value });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.writeRpcResponse({ type: "rpc_response", id: rpcId, ok: false, error: message });
		} finally {
			clearTimeout(timer);
			// Re-arm a fresh exec timeout now that Python resumes computing. If the
			// REPL failed/closed meanwhile, pendingExec is already gone — no-op.
			this.rearmExecTimeout();
		}
	}

	private rearmExecTimeout(): void {
		if (!this.pendingExec) return;
		this.pendingExec.timeout = setTimeout(() => {
			this.fail(new Error("Exec timeout"));
		}, this.options.execTimeoutMs);
	}

	private writeRpcResponse(response: Record<string, unknown>): void {
		// RPC handlers are async; the process may be gone by the time one finishes.
		if (this.state === "closed" || this.state === "failed") return;
		if (!this.proc || this.proc.killed || !this.proc.stdin || !this.proc.stdin.writable) return;
		try {
			this.proc.stdin.write(`${JSON.stringify(response)}\n`);
		} catch (err) {
			this.fail(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private fail(err: Error): void {
		if (this.state === "closed" || this.state === "failed") return;
		this.state = "failed";

		if (this.pendingExec) {
			this.clearExecTimeout();
			this.pendingExec.reject(this.enrichError(err));
			this.pendingExec = null;
		}

		if (this.readyDeferred) {
			this.clearReadyTimeout();
			this.readyDeferred.reject(this.enrichError(err));
			this.readyDeferred = null;
		}

		this.kill();
		this.finishClose();
	}

	private enrichError(err: Error): Error {
		const parts: string[] = [err.message];
		if (this.stderrBuffer) {
			parts.push(`\n--- Python stderr ---\n${this.stderrBuffer}`);
		}
		return new Error(parts.join(""));
	}

	private kill(): void {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		try {
			proc.kill("SIGTERM");
		} catch {
			return;
		}
		// proc.killed only means the signal was sent. Escalate to SIGKILL if the
		// process is still running after a grace period (moot on Windows, where
		// SIGTERM terminates outright).
		const killTimer = setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}, 1_000);
		killTimer.unref();
		proc.once("close", () => clearTimeout(killTimer));
	}

	private finishClose(): void {
		if (this.abortHandler && this.options.signal) {
			this.options.signal.removeEventListener("abort", this.abortHandler);
			this.abortHandler = null;
		}
		if (this.closeResolve) {
			this.closeResolve();
			this.closeResolve = null;
		}
	}

	ready(): Promise<void> {
		// "executing" means the host booted and is busy; waiting for a "ready"
		// message here would never resolve and the startup timeout would kill
		// the running exec.
		if (this.state === "ready" || this.state === "executing") return Promise.resolve();
		if (this.state === "closed") return Promise.reject(new Error("REPL is closed"));
		if (this.state === "failed") return Promise.reject(new Error("REPL has failed"));
		if (this.readyDeferred) return Promise.reject(new Error("Already waiting for ready"));

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.fail(new Error("Startup timeout"));
			}, this.options.startupTimeoutMs);
			this.readyDeferred = { resolve, reject, timeout };
		});
	}

	exec(code: string): Promise<ExecResult> {
		return this.sendRequest({ type: "exec", code });
	}

	async setVar(name: string, value: unknown): Promise<void> {
		const result = await this.sendRequest({ type: "set_var", name, value });
		if (result.error) {
			throw new Error(`setVar(${JSON.stringify(name)}) failed: ${result.error}`);
		}
	}

	private sendRequest(payload: Record<string, unknown>): Promise<ExecResult> {
		if (this.state === "closed") return Promise.reject(new Error("REPL is closed"));
		if (this.state === "failed") return Promise.reject(new Error("REPL has failed"));
		if (this.pendingExec) return Promise.reject(new Error("Only one exec allowed at a time"));
		if (this.state !== "ready") return Promise.reject(new Error("REPL is not ready"));
		if (!this.proc || this.proc.killed) return Promise.reject(new Error("Python process is not running"));

		const id = this.nextId++;
		const msg = JSON.stringify({ ...payload, id });

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.fail(new Error("Exec timeout"));
			}, this.options.execTimeoutMs);
			this.pendingExec = { id, resolve, reject, timeout };
			this.state = "executing";
			try {
				this.proc!.stdin!.write(`${msg}\n`);
			} catch (err) {
				this.fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	async close(): Promise<void> {
		if (this.state === "closed" || this.state === "failed") {
			this.finishClose();
			return;
		}

		this.state = "closed";

		if (this.pendingExec) {
			this.clearExecTimeout();
			this.pendingExec.reject(new Error("REPL was closed"));
			this.pendingExec = null;
		}

		if (this.readyDeferred) {
			this.clearReadyTimeout();
			this.readyDeferred.reject(new Error("REPL was closed"));
			this.readyDeferred = null;
		}

		if (this.proc && !this.proc.killed && this.proc.stdin && this.proc.stdin.writable) {
			try {
				this.proc.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			} catch {
				/* ignore */
			}
		}

		if (this.proc && !this.proc.killed) {
			const killTimer = setTimeout(() => {
				this.kill();
			}, this.options.shutdownTimeoutMs);
			await this.closePromise;
			clearTimeout(killTimer);
		}

		this.finishClose();
	}

	private clearReadyTimeout(): void {
		if (this.readyDeferred) {
			clearTimeout(this.readyDeferred.timeout);
		}
	}

	private clearExecTimeout(): void {
		if (this.pendingExec) {
			clearTimeout(this.pendingExec.timeout);
		}
	}
}
