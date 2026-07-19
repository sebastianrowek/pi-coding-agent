import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentKBOptions {
	pythonPath: string;
	agentkbCwd: string;
	timeoutMs?: number;
	restrictReadRoot?: string;
	signal?: AbortSignal;
}

export interface AgentKBHit {
	path: string;
	file?: string;
	filename?: string;
	score?: number;
	title?: string;
	section?: string;
	tags?: string[];
	snippet?: string;
}

export const DEFAULT_AGENTKB_CWD = "C:\\Appl\\workspace\\Python\\agentkb";
export const DEFAULT_AGENTKB_PYTHON = "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

const MAX_DIAGNOSTIC_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function cap(text: string): string {
	if (text.length <= MAX_DIAGNOSTIC_CHARS) return text;
	return `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n... (truncated)`;
}

function runAgentKb(options: AgentKBOptions, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			options.pythonPath,
			["-m", "agentkb", ...args],
			{
				cwd: options.agentkbCwd,
				windowsHide: true,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: 16 * 1024 * 1024,
				signal: options.signal,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(
							`agentkb ${args[0]} failed: ${err.message}\nstderr:\n${cap(stderr)}\n\nstdout:\n${cap(stdout)}`,
						),
					);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

function parseAgentKbJson(stdout: string, stderr: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		// Fall through to extraction below.
	}

	const first = stdout.indexOf("{");
	const last = stdout.lastIndexOf("}");
	if (first !== -1 && last > first) {
		try {
			return JSON.parse(stdout.slice(first, last + 1));
		} catch {
			// Fall through to the diagnostic error below.
		}
	}

	throw new Error(`Failed to parse agentkb JSON output.\nstderr:\n${cap(stderr)}\n\nstdout:\n${cap(stdout)}`);
}

export async function kbSearch(options: AgentKBOptions, query: string, k = 5, scope = "wiki"): Promise<AgentKBHit[]> {
	if (typeof query !== "string" || !query.trim()) {
		throw new Error("kb_search: query must be a non-empty string");
	}

	const safeK = Number(k);
	if (!Number.isFinite(safeK)) {
		throw new Error("kb_search: k must be a number");
	}
	const normalizedK = Math.trunc(safeK);
	if (normalizedK < 1 || normalizedK > 50) {
		throw new Error("kb_search: k must be between 1 and 50");
	}

	if (typeof scope !== "string" || !scope.trim()) {
		throw new Error("kb_search: scope must be a non-empty string");
	}

	// "--" keeps a query starting with "-" from being parsed as a CLI option.
	const { stdout, stderr } = await runAgentKb(options, [
		"search",
		"--json",
		"-k",
		String(normalizedK),
		"-s",
		scope,
		"--",
		query,
	]);

	const parsed = parseAgentKbJson(stdout, stderr);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`agentkb search output is not an object.\nstdout:\n${cap(stdout)}`);
	}
	const results = (parsed as Record<string, unknown>).results;
	if (!Array.isArray(results)) {
		throw new Error(`agentkb search output has no "results" array.\nstdout:\n${cap(stdout)}`);
	}

	const hits: AgentKBHit[] = [];
	for (const entry of results) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const raw = entry as Record<string, unknown>;

		const hitPath = typeof raw.path === "string" && raw.path.trim() ? raw.path : raw.file;
		if (typeof hitPath !== "string" || !hitPath.trim()) continue;

		hits.push({
			path: hitPath,
			file: typeof raw.file === "string" ? raw.file : undefined,
			filename: typeof raw.filename === "string" ? raw.filename : undefined,
			score: typeof raw.score === "number" ? raw.score : undefined,
			title: typeof raw.title === "string" ? raw.title : undefined,
			section: typeof raw.section === "string" ? raw.section : undefined,
			tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : undefined,
			snippet: typeof raw.snippet === "string" ? raw.snippet : undefined,
		});
	}
	return hits;
}

export async function kbRead(options: AgentKBOptions, filePath: string): Promise<string> {
	if (typeof filePath !== "string" || !filePath.trim()) {
		throw new Error("kb_read: path must be a non-empty string");
	}

	// Lexical containment check only: paths are not realpath'd, so a
	// symlink/junction inside the root that points outside it can escape.
	const root = path.resolve(options.restrictReadRoot ?? options.agentkbCwd);
	const resolved = path.resolve(filePath);

	const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
	const resolvedCmp = process.platform === "win32" ? resolved.toLowerCase() : resolved;

	// Drive roots like "C:\" already end with a separator.
	const rootPrefix = rootCmp.endsWith(path.sep) ? rootCmp : rootCmp + path.sep;
	if (resolvedCmp !== rootCmp && !resolvedCmp.startsWith(rootPrefix)) {
		throw new Error("kb_read path is outside the configured agentkb root");
	}

	return await fs.promises.readFile(resolved, "utf8");
}
