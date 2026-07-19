import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { capText, type InvestigatorEvent } from "./investigator.ts";

export const DEFAULT_LOG_DIR = path.join(os.homedir(), ".pi", "rlm-logs");

/** Cap for turn texts, code blocks, answers, and the run question in log lines. */
export const LOG_TEXT_CAP_CHARS = 20_000;
/** Cap for RPC payload previews and nested-run prompts in log lines. */
export const LOG_PREVIEW_CAP_CHARS = 500;

/**
 * One NDJSON line per event. `inv` is the investigation path id: "root" for
 * the top level, "root.1" / "root.2" for its children (assigned in call order
 * per parent), "root.1.1" for a grandchild. One file covers the whole
 * recursion tree; `inv` + `ts` reconstruct the (interleaved) execution.
 */
export type RlmLogEvent =
	| {
			inv: string;
			event: "run_start";
			question: string;
			investigator: string;
			analyst: string;
			maxTurns: number;
			maxDepth: number;
			maxBudgetUsd: number;
			maxLlmCalls: number;
			k: number;
			scope: string;
			contextHits: number;
			contextNote?: string;
	  }
	| { inv: string; event: "turn_start"; turn: number }
	| { inv: string; event: "assistant_text"; turn: number; text: string }
	| { inv: string; event: "code_block"; turn: number; code: string }
	| { inv: string; event: "exec_result"; turn: number; text: string }
	| {
			inv: string;
			event: "rpc";
			method: string;
			ok: boolean;
			durationMs: number;
			argsPreview: string;
			resultPreview?: string;
			resultChars?: number;
			error?: string;
	  }
	| { inv: string; event: "nested_start"; child: string; depth: number; prompt: string }
	| { inv: string; event: "nested_end"; child: string; stopReason: string; turns: number }
	| { inv: string; event: "downgrade"; depth: number; prompt: string }
	| {
			inv: string;
			event: "run_end";
			stopReason: string;
			turns: number;
			costUsd?: number;
			modelCalls?: number;
			nestedRuns?: number;
			answer?: string;
	  };

/** Capped JSON preview of an RPC payload; String() fallback, never throws. */
export function preview(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return capText(text, LOG_PREVIEW_CAP_CHARS);
}

/** Sortable timestamp + random suffix, e.g. "20260611-153012-4f2a". */
export function newRunId(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

const TEXT_CAP_FIELDS = ["text", "code", "answer", "question"] as const;
const PREVIEW_CAP_FIELDS = ["prompt", "argsPreview", "resultPreview", "error"] as const;

/** Caps applied centrally so no logging call site can forget them. */
function withCaps(event: RlmLogEvent): RlmLogEvent {
	const e: Record<string, unknown> = { ...event };
	for (const field of TEXT_CAP_FIELDS) {
		if (typeof e[field] === "string") e[field] = capText(e[field] as string, LOG_TEXT_CAP_CHARS);
	}
	for (const field of PREVIEW_CAP_FIELDS) {
		if (typeof e[field] === "string") e[field] = capText(e[field] as string, LOG_PREVIEW_CAP_CHARS);
	}
	return e as RlmLogEvent;
}

/**
 * Fire-and-forget NDJSON writer for one investigation tree. Logging is
 * best-effort by design: the first write failure disables the logger (one
 * warn), and log() never throws into the investigation.
 */
export class RlmLogger {
	readonly runId: string;
	readonly logPath: string;
	private warn?: (msg: string) => void;
	/** Serializes writes so concurrent batched children can't interleave bytes. */
	private queue: Promise<void> = Promise.resolve();
	private disabled = false;
	private closed = false;

	constructor(runId: string, logPath: string, warn?: (msg: string) => void) {
		this.runId = runId;
		this.logPath = logPath;
		this.warn = warn;
	}

	log(event: RlmLogEvent): void {
		if (this.disabled || this.closed) return;
		let line: string;
		try {
			line = `${JSON.stringify({ ts: new Date().toISOString(), run: this.runId, ...withCaps(event) })}\n`;
		} catch {
			// Events are built from strings and numbers; an unserializable one is a
			// bug, but logging must never throw into the run.
			return;
		}
		this.queue = this.queue.then(async () => {
			if (this.disabled) return;
			try {
				await fs.promises.appendFile(this.logPath, line, "utf8");
			} catch (err) {
				this.disabled = true;
				this.warn?.(`rlm log disabled: ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	}

	/** Flushes pending writes. Events logged after close() are dropped. */
	async close(): Promise<void> {
		this.closed = true;
		await this.queue;
	}
}

/**
 * Creates the log directory and file for a new run. Failure throws — the
 * caller (index.ts) degrades to a logger-less run with one transcript note.
 */
export async function createRunLogger(logDir: string, warn?: (msg: string) => void): Promise<RlmLogger> {
	await fs.promises.mkdir(logDir, { recursive: true });
	// "wx" surfaces an unwritable directory here (not mid-run) and turns a run
	// id collision into a retry instead of two runs sharing a file.
	for (let attempt = 0; ; attempt++) {
		const runId = newRunId();
		const logPath = path.join(logDir, `${runId}.ndjson`);
		try {
			await fs.promises.writeFile(logPath, "", { encoding: "utf8", flag: "wx" });
			return new RlmLogger(runId, logPath, warn);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" || attempt >= 2) throw err;
		}
	}
}

/**
 * onEvent adapter: forwards InvestigatorEvents to the logger under `inv`,
 * then to `next` (e.g. index.ts's timeline recorder). "done" produces no log
 * line — run_end / nested_end carry the terminal state.
 */
export function loggingOnEvent(
	logger: RlmLogger | undefined,
	inv: string,
	next?: (ev: InvestigatorEvent) => void,
): (ev: InvestigatorEvent) => void {
	return (ev) => {
		if (logger) {
			if (ev.type === "turn_start") {
				logger.log({ inv, event: "turn_start", turn: ev.turn });
			} else if (ev.type === "assistant_text") {
				logger.log({ inv, event: "assistant_text", turn: ev.turn, text: ev.text ?? "" });
			} else if (ev.type === "code_block") {
				logger.log({ inv, event: "code_block", turn: ev.turn, code: ev.text ?? "" });
			} else if (ev.type === "exec_result") {
				logger.log({ inv, event: "exec_result", turn: ev.turn, text: ev.text ?? "" });
			}
		}
		next?.(ev);
	};
}
