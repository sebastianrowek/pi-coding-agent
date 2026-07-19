# RLM Extension — Phase 6 Implementation Plan

## Phase 6 Goal

Make investigations observable and the tool presentable — the final v1 phase per
PLAN.md ("v1 = phases 1-6"):

- **NDJSON run logging** (`logging.ts`): one line per event to
  `~/.pi/rlm-logs/<runId>.ndjson` (locked in PLAN.md), covering the whole recursion
  tree in one file — run lifecycle, per-turn investigator events at every depth, RPC
  builtin calls, nested-run lifecycle, downgrades.
- **Rich `renderCall` / `renderResult`**: collapsed = status + answer + cost/turns
  summary; expanded = per-turn prose/code/output timeline with nested-run markers
  (reuse the subagent example's rendering patterns).
- **`promptSnippet` / `promptGuidelines`**: tell the main agent when to reach for
  `rlm_query` so noisy KB research stays out of the main context.
- `details` gains `runId`, `logPath`, and a structured `timeline` (PLAN.md tool
  surface: `details: { turns, cost, runId, logPath }`).

Phase 6 does **not** implement:

- Jupyter export (deferred indefinitely, per PLAN.md locked decision 5).
- Any host.py / repl.ts protocol changes — `_RLM_HOST_PHASE` stays **5**; no
  phase-marker churn in the existing suites this time.

---

## 1. Current State (verified against the code)

- `index.ts` — `execute()` builds a flat `transcript: string[]`, streams it via
  `pushUpdate()` (tail-weighted `capTranscript`, 20 000 chars), and returns
  `details: { stopReason, turns, costUsd, modelCalls, contextHits, nestedRuns }`.
  No `renderCall`/`renderResult`/`promptSnippet`/`promptGuidelines`. The
  `onNested` callback already pushes `[depth N rlm_query started/finished ...]`
  lines, with a code comment "Phase 6 owns proper rendering".
- `investigator.ts` — `runInvestigation()` emits `InvestigatorEvent`
  (`turn_start` / `assistant_text` / `code_block` / `exec_result` / `done`, each
  with `turn` and optional `text`) through `opts.onEvent`. The `done` event fires
  on every exit path. This is the complete per-turn event surface logging needs —
  **no changes needed**.
- `rpc.ts` — `createRpcHandlers(kb, llm, rlm)` builds six handlers (two plain KB
  functions, four `{ handler, timeoutMs }` entries). `runNestedRlmQuery()` emits
  `onNested` start/end (with the no-double-emit `emitEnd` guard) but passes **no
  `onEvent`** to child runs (deliberate Phase 5 deferral — child turn detail is
  currently invisible). Downgrades are silent. RPC calls (method, duration,
  success/failure) are observable nowhere. Phase 6 extends this file.
- `repl.ts`, `budget.ts`, `agentkb.ts`, `prompt.ts`, `host.py` — **no changes
  needed.** RPC logging wraps handlers in `rpc.ts`; `repl.ts` stays
  logging-agnostic.
- Extension tool API (verified in `packages/coding-agent/src/core/extensions/types.ts`):
  - `promptSnippet?: string` — one-liner for the Available-tools section (built-in
    style: `"Search file contents for patterns (respects .gitignore)"`).
  - `promptGuidelines?: string[]` — bullets appended to the Guidelines section.
  - `renderCall(args, theme, context) => Component`.
  - `renderResult(result, { expanded, isPartial }, theme, context) => Component` —
    `isPartial: true` during streaming, so the live view and the final view are the
    same code path reading `result.details`.
  - Rendering building blocks proven by the subagent example:
    `Text`/`Container`/`Markdown`/`Spacer` from `@earendil-works/pi-tui`,
    `getMarkdownTheme` from `@earendil-works/pi-coding-agent`,
    `theme.fg(color, text)` / `theme.bold(text)`.
- Tests: 68 green on the private machine via `RLM_PYTHON` (13 + 20 + 18 + 17).
  Phase 6 must not change `createRpcHandlers`'s required surface — new
  `RlmRecursionOptions` fields are optional, so **no existing call sites change**.

---

## 2. File-by-File Plan

```text
.pi/extensions/rlm/
  logging.ts     NEW: RlmLogger (NDJSON writer), run id, event types, wiring helpers
  rpc.ts         extend: inv ids, logger plumbing, RPC-call logging, child onEvent
  index.ts       extend: logger lifecycle, structured timeline details, logDir param,
                 promptSnippet/promptGuidelines, renderCall/renderResult
  test-phase6.ts NEW: logger + wiring + formatter tests
  PHASE6.md      this plan
```

---

## 2.1 `logging.ts` — NDJSON Run Logger

### Run id and file

```typescript
export const DEFAULT_LOG_DIR = path.join(os.homedir(), ".pi", "rlm-logs");
// e.g. 20260611-153012-4f2a — sortable, collision-safe enough for one machine
export function newRunId(): string;
```

`createRunLogger(logDir: string, warn?: (msg: string) => void): Promise<RlmLogger>`
creates the directory (`mkdir recursive`), generates the run id, and returns a
logger bound to `<logDir>/<runId>.ndjson`. Directory/file creation failure throws —
the **caller** (index.ts) catches it and degrades to a no-op logger plus one
transcript note, mirroring the initial-`kb_search` degradation pattern.

### Writer semantics

```typescript
export class RlmLogger {
	readonly runId: string;
	readonly logPath: string;
	log(event: RlmLogEvent): void;     // fire-and-forget, never throws
	close(): Promise<void>;            // flush queue; later log() calls are dropped
}
```

- One `fs.promises.appendFile` per event, **serialized through an internal promise
  chain** (`queue = queue.then(write)`) so concurrent events from batched children
  can never interleave bytes within a line.
- First write failure: set a disabled flag, call `warn` once
  (`"rlm log disabled: <err>"`), drop all subsequent events. Logging is
  best-effort by design — it must never fail an investigation.
- `close()` awaits the queue. Events logged after `close()` (e.g. a handler that
  lost its timeout race and settles late) are dropped — the file is complete once
  `run_end` is written.

### Event schema

Every line: `{ ts, run, inv, event, ...fields }` where `ts` is ISO-8601, `run` is
the run id, and `inv` is the investigation path id — `"root"` for the top level,
`"root.1"`, `"root.2"` for its children, `"root.1.1"` for a grandchild. One file
per tree; `inv` + `ts` reconstruct the (interleaved) execution.

| event | fields |
|---|---|
| `run_start` | `question`, `investigator` (`provider/id`), `analyst`, `maxTurns`, `maxDepth`, `maxBudgetUsd`, `maxLlmCalls`, `k`, `scope`, `contextHits`, `contextNote?` |
| `turn_start` | `turn` |
| `assistant_text` | `turn`, `text` (capped) |
| `code_block` | `turn`, `code` (capped) |
| `exec_result` | `turn`, `text` (the already-capped observation) |
| `rpc` | `method`, `ok`, `durationMs`, `argsPreview` (capped 500), and `resultPreview` (capped 500) + `resultChars` on success or `error` on failure |
| `nested_start` | `child` (child inv id), `depth`, `prompt` (capped 500) |
| `nested_end` | `child`, `stopReason`, `turns` |
| `downgrade` | `depth`, `prompt` (capped 500) — an `rlm_query` that became one analyst call |
| `run_end` | `stopReason`, `turns`, `costUsd`, `modelCalls`, `nestedRuns`, `answer` (capped) |

Caps (constants in `logging.ts`): `LOG_TEXT_CAP_CHARS = 20_000` for
`text`/`code`/`answer` via `capText`; `LOG_PREVIEW_CAP_CHARS = 500` for RPC
payload previews and prompts. Full `kb_read` payloads do not belong in the log —
`resultChars` records the size.

### Wiring helpers (keep index.ts thin and the wiring testable)

```typescript
/** onEvent adapter: forwards InvestigatorEvents to the logger under inv. */
export function loggingOnEvent(
	logger: RlmLogger | undefined,
	inv: string,
	next?: (ev: InvestigatorEvent) => void,
): (ev: InvestigatorEvent) => void;
```

`loggingOnEvent` maps `turn_start`/`assistant_text`/`code_block`/`exec_result` to
their log events (skipping `done` — `run_end`/`nested_end` carry the terminal
state) and then calls `next` (index.ts's existing transcript/timeline recorder).
Both the top level and nested runs use the same adapter, so the mapping is
written and tested once.

---

## 2.2 `rpc.ts` — Investigation Ids, RPC Logging, Child Events

### 2.2.1 `RlmRecursionOptions` additions (all optional — no call-site churn)

```typescript
/** Investigation path id of the handler-set owner. Default "root". */
inv?: string;
/** Shared tree logger; absent in tests and when log setup failed. */
logger?: RlmLogger;
```

Optional is the semantically right shape here (not a back-compat shim): tests and
log-disabled runs legitimately run without a logger, and `inv` has exactly one
sensible default.

### 2.2.2 RPC-call logging

At the top of `createRpcHandlers`, resolve `const inv = rlm.inv ?? "root"` and a
local child counter (`let childSeq = 0` — one per handler set, i.e. one per
investigation, so sibling children of one parent get `.1`, `.2`, ...).

Wrap every handler (normalize plain functions and entries first) with a timing
decorator when `rlm.logger` is set:

```typescript
function withRpcLogging(method: string, handler: RpcHandler): RpcHandler {
	return async (args) => {
		const start = Date.now();
		try {
			const value = await handler(args);
			logger.log({ inv, event: "rpc", method, ok: true, durationMs: Date.now() - start,
				argsPreview: preview(args), resultPreview: preview(value), resultChars: chars(value) });
			return value;
		} catch (err) {
			logger.log({ inv, event: "rpc", method, ok: false, durationMs: Date.now() - start,
				argsPreview: preview(args), error: message(err) });
			throw err;
		}
	};
}
```

`preview()` = `capText(JSON.stringify(x), 500)` with a `String(x)` fallback for
non-serializable values. Known accepted gaps (document in code): the
unknown-method path and the handler-timeout path live in `repl.ts` and are not
logged (the timeout loser logs late on settle and is dropped post-close); both
are visible in the exec traceback anyway.

### 2.2.3 `runNestedRlmQuery` changes

- **Downgrade**: before delegating to `runAnalystCall`, log
  `{ event: "downgrade", depth: rlm.depth, prompt }`. (The analyst call itself is
  already visible as the parent's `rpc` event for `rlm_query` — the downgrade
  event explains *why* no child run follows.)
- **Child inv id**: `const childInv = `${inv}.${++childSeq}`` (counter shared via
  the handler-set closure; pass it into `runNestedRlmQuery` or derive the id in
  the handler and hand it down — implementer's choice, but ids must be assigned
  in call order).
- **Lifecycle**: log `nested_start` (with `child: childInv`, `depth`, capped
  prompt) right where `onNested({ phase: "start" })` fires today, and
  `nested_end` inside the existing `emitEnd` guard so the no-double-emit and
  error-path coverage carry over for free.
- **Child wiring**: the child's `createRpcHandlers` call gets
  `{ ...rlm, depth: childDepth, inv: childInv }` (logger rides along in the
  spread), and `runInvestigation` gets
  `onEvent: loggingOnEvent(rlm.logger, childInv)` — child turn detail goes to the
  **log only**, not to the parent's live transcript (locked decision 5 below).

---

## 2.3 `index.ts` — Logger Lifecycle, Timeline Details, Rendering, Prompt Surface

### 2.3.1 New param

```typescript
logDir: Type.Optional(Type.String({
	description: "Directory for NDJSON run logs. Default ~/.pi/rlm-logs.",
})),
```

No validation beyond what `mkdir` enforces; creation failure degrades (below).

### 2.3.2 Logger lifecycle in `execute()`

1. After param validation: `logger = await createRunLogger(params.logDir ?? DEFAULT_LOG_DIR, warn)`
   in a try/catch; on failure `logger = undefined` and push a transcript/timeline
   note (`[run logging disabled: <err>]`) — same degradation philosophy as the
   initial `kb_search`.
2. After the context search and prompt build: `logger?.log({ inv: "root", event: "run_start", ... })`.
3. Top-level `runInvestigation` gets `onEvent: loggingOnEvent(logger, "root", onEvent)`
   where `onEvent` is the existing transcript recorder.
4. Pass `inv: "root"` and `logger` in the recursion options.
5. In `finally` (before `repl.close()` or after — order is irrelevant, both must
   run): log `run_end` with the result fields (or
   `stopReason: signal?.aborted ? "aborted" : "error"` when `runInvestigation`
   itself threw), then `await logger.close()`.
6. `details` gains `runId: logger?.runId`, `logPath: logger?.logPath`.

### 2.3.3 Structured timeline in `details`

Replace the flat `transcript: string[]` with a structured list the renderer can
style (the plain-text `content` for `onUpdate` is derived from it, so non-UI
consumers lose nothing):

```typescript
export interface TimelineEntry {
	kind: "note" | "turn" | "assistant" | "exec" | "nested_start" | "nested_end";
	turn?: number;
	depth?: number;       // nested_* entries
	text: string;          // capped at TIMELINE_ENTRY_CAP_CHARS
}
```

- `RlmQueryDetails` gains `runId?`, `logPath?`, `timeline: TimelineEntry[]`.
- Caps: `TIMELINE_ENTRY_CAP_CHARS = 2_000` per entry (head+tail `capText`),
  `TIMELINE_MAX_ENTRIES = 200` (drop from the front, prepend one
  `{ kind: "note", text: "[... N earlier entries dropped]" }`). Details are
  persisted into the session JSONL — these caps bound session bloat while staying
  far above what a 12-turn run produces.
- The existing `onEvent` / `onNested` callbacks push `TimelineEntry`s instead of
  strings; `pushUpdate()` renders entries to the same plain text as today for
  `content`.
- Extract the entry-to-text and stats formatting as pure exported helpers so
  tests cover them without a TUI:

```typescript
export function timelineToText(entries: TimelineEntry[]): string;
export function formatRunStats(details: RlmQueryDetails): string;
// e.g. "final · 5 turns · 23 calls · $0.0841 · 2 nested · 5 ctx hits"
```

### 2.3.4 `promptSnippet` / `promptGuidelines`

```typescript
promptSnippet: "Deep research over the local knowledge base via an isolated REPL investigation (rlm_query)",
promptGuidelines: [
	"Use rlm_query for knowledge-base/wiki research questions instead of exploring the KB yourself; it keeps the noisy search/read work out of this context and returns a synthesized answer.",
	"Give rlm_query one self-contained question with all needed constraints; it cannot see this conversation.",
	"rlm_query spends real model budget (default $0.50 cap per call); prefer one well-scoped question over many small ones.",
],
```

(Exact wording tuned during implementation; match the terse style of the
built-ins — `write.ts`, `read.ts`.)

### 2.3.5 `renderCall`

Single-line header + dimmed prompt preview, subagent-style:

```
rlm_query What does the wiki say about the Foo deployment pipeline?...
  [scope=infra k=8 maxDepth=0]            <- muted, only non-default params
```

- `theme.fg("toolTitle", theme.bold("rlm_query "))` + accent prompt capped at
  ~80 chars.
- Second muted line listing only params that differ from defaults
  (scope/k/maxTurns/maxDepth/maxBudget/models); omit the line when all default.
- Returns `new Text(text, 0, 0)`.

### 2.3.6 `renderResult`

Reads `result.details` (`RlmQueryDetails`); same code path for partial and final.

**Running (`isPartial`)**: header
`⏳ investigating… turn N · M calls · K nested` plus the tail of the timeline
(last ~8 entries via `timelineToText`), so live progress shows the current turn
and nested markers.

**Collapsed (final)**: status icon by `stopReason` —
`final` ✓ success; `no_code`/`max_turns`/`budget` ◐ warning; `error`/`aborted`
✗ error — then `formatRunStats` on the header line, the first ~10 lines of the
answer as plain text, and `(Ctrl+O to expand)`.

**Expanded (final)**: `Container` with:

1. Header (icon + stats).
2. `─── Investigation ───`: the full timeline — `--- turn N ---` separators
   muted, assistant prose (fenced code included, as today) in `toolOutput`, exec
   observations dimmed, nested markers in accent indented by depth.
3. `─── Answer ───`: `new Markdown(answer, 0, 0, getMarkdownTheme())`.
4. Footer (dim): `runId` + `logPath` (`log: ~/.pi/rlm-logs/<runId>.ndjson`).

Fallback when `details`/`timeline` are missing (old sessions, degenerate
results): render `result.content[0].text` plainly, like the subagent example's
last-resort branch.

`renderShell` stays default (standard colored tool shell).

---

## 3. Testing Plan — `test-phase6.ts`

Same conventions: standalone script, run via

```text
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase6.ts
```

Log files go to a fresh temp dir per test (`fs.mkdtempSync`), removed afterwards.

### Logger-level (no REPL)

1. `createRunLogger` creates the dir and file path `<dir>/<runId>.ndjson`; two
   loggers created back-to-back get distinct run ids.
2. Events written in call order; every line parses as JSON; shared `run` id; `ts`
   parses as a date; field round-trip (log a known `run_start`, read it back).
3. Serialization under concurrency: fire 50 `log()` calls with multi-KB payloads
   from interleaved async tasks → file has exactly 50 lines, all parse.
4. Capping: a 100 000-char `text` lands capped (≤ `LOG_TEXT_CAP_CHARS` + marker
   overhead) with the omission marker present.
5. Failure degradation: point the logger at a path whose parent is a **file** →
   `createRunLogger` throws (caller-degradation contract); separately, force a
   write failure after creation (delete the dir between create and first log) →
   `warn` called exactly once, `log()` never throws, subsequent events dropped.
6. `close()` flushes pending writes (log 20 events, close, count lines == 20);
   `log()` after `close()` is dropped without error.

### Wiring-level (real REPL, fake completeFns — the Phase 3-5 harness)

7. `loggingOnEvent`: drive a scripted single-investigation run with the adapter →
   file contains `turn_start`/`assistant_text`/`code_block`/`exec_result` with
   the right `inv` and turn numbers; `done` produces no line; the `next` callback
   still received every event (transcript unbroken).
8. RPC logging: handlers built with a logger and a mock `kb_search`; a block
   calls `kb_search("x")` → one `rpc` event with `method: "kb_search"`,
   `ok: true`, `durationMs >= 0`, previews present; a throwing handler →
   `ok: false` with the error message, and the Python traceback still reaches the
   block (logging is observability, not behavior).
9. Nested run logging: two-level scripted recursion (Phase 5 test 17 shape) with
   a shared logger → `nested_start`/`nested_end` with `child: "root.1"`, child
   `turn_start`/`assistant_text` events under `inv: "root.1"`, parent events
   under `"root"`, all in one file; sibling children get `"root.1"`, `"root.2"`
   in call order.
10. Downgrade logging: `depth == maxDepth` handlers → `downgrade` event logged,
    no `nested_start`.
11. No-logger paths: every wiring point with `logger: undefined` still works
    (run the test-7 and test-9 scenarios without a logger; assert behavior
    identical and no file created) — guards the optionality contract.

### Formatter/detail-level (pure functions, no REPL, no TUI)

12. Timeline recording: scripted run → `details.timeline` entries have the right
    kinds/turns; entry texts capped at 2 000; pushing > `TIMELINE_MAX_ENTRIES`
    drops from the front and prepends the dropped-note entry.
13. `timelineToText` output matches the current transcript format (turn
    separators, nested markers) for a representative entry list.
14. `formatRunStats`: contains stopReason, turns, calls, `$`-cost (4 decimals),
    nested count; omits absent optional fields gracefully.
15. Render smoke (best-effort): call `renderCall`/`renderResult` with a stub
    theme (`fg: (_c, s) => s`, `bold: (s) => s`) and assert the returned
    component's rendered text contains the prompt preview / stats / answer head.
    If driving pi-tui components headlessly turns out awkward, keep the pure
    helpers (tests 13-14) as the coverage and verify components manually in
    tmux — note the decision in PHASE6-NOTES.

### Existing suites

16. Rerun phases 2-5 unchanged — no signature or phase-marker changes, all 68
    must stay green untouched. (If any file needs edits here, the optionality
    contract was broken — fix the implementation, not the tests.)

### Manual / integration

- **tmux TUI test** (per CLAUDE.md): run `./pi-test.sh`, issue an `rlm_query`,
  capture panes for (a) the running partial view, (b) collapsed result,
  (c) Ctrl+O expanded timeline + answer + log footer. Verify the system prompt
  lists the snippet (`/debug` or equivalent prompt dump).
- **Corporate machine end-to-end** (also closes the Phase 5 leftovers): a real
  decomposing question → verify `rlm_query`/nested markers in the rendered
  timeline, `details.runId`/`logPath` set, the NDJSON file exists and every line
  parses (`jq -c . <file> > /dev/null`), `run_start`/`run_end` bracket the run,
  child events carry `root.N` ids, Esc mid-run writes `run_end` with
  `stopReason: "aborted"` and kills all Python processes.
- Rerun `RLM_AGENTKB_TESTS=1` integration tests.

---

## 4. Edge Cases

| Edge case | Handling |
|---|---|
| Log dir not creatable / not writable | `createRunLogger` throws → index.ts degrades to no logger + one timeline note; investigation unaffected. |
| Write failure mid-run | Logger disables itself, warns once, drops the rest; never throws into the run. |
| Abort (Esc) mid-run | `finally` still logs `run_end` (`stopReason: "aborted"`) and closes the logger. |
| Handler loses timeout race, settles later | Its `rpc` event logs late; if the run already closed the logger, the event is dropped. Accepted — the timeout is visible in the block's traceback. |
| Concurrent batched children logging | Promise-chain queue serializes lines; `inv` ids disambiguate interleaved events. |
| Huge `kb_read` / assistant output | Log previews + char counts for RPC payloads; 20k cap for turn texts; timeline entries capped at 2k. |
| `details` bloat in session JSONL | 200-entry / 2k-per-entry timeline caps; answer stays uncapped only in `content`. |
| Old/degenerate results in `renderResult` | Missing `details.timeline` → plain `content[0].text` fallback. |
| Non-JSON-serializable RPC arg/result in `preview()` | `String(x)` fallback; never throws from the logging path. |
| Run id collision | Timestamp + random suffix; per-machine uniqueness is sufficient. |
| Logger absent (tests, degraded runs) | Every wiring point is `logger?.log(...)`-style optional; covered by test 11. |
| `run_end` when `runInvestigation` throws | Logged from the catch/finally with `error`/`aborted` stop reason so files never end mid-run. |

---

## 5. Build Order

1. `logging.ts`: run id, `RlmLogger` (queue, disable-on-failure, close), event
   types, caps, `loggingOnEvent`, `preview()` → tests 1-6 green.
2. `rpc.ts`: `inv`/`logger` options, `withRpcLogging` wrapper, child inv ids,
   `nested_start`/`nested_end`/`downgrade` events, child `onEvent` wiring →
   tests 7-11 green; rerun phases 2-5 (must be untouched and green).
3. `index.ts` part 1: `logDir` param, logger lifecycle, `run_start`/`run_end`,
   timeline recording (`TimelineEntry`, caps, `timelineToText`,
   `formatRunStats`), `details.runId`/`logPath`/`timeline` → tests 12-14 green.
4. `index.ts` part 2: `promptSnippet`/`promptGuidelines`, `renderCall`,
   `renderResult` (partial/collapsed/expanded) → test 15 (or the documented
   manual fallback), then tmux verification.
5. `test-phase6.ts` complete; full suite pass on the private machine
   (`RLM_PYTHON`).
6. Manual corporate-machine end-to-end (also closes Phase 5's open items);
   `RLM_AGENTKB_TESTS=1` rerun.
7. Type-check + biome via the temporary-config approach from Phases 2-5; no new
   `npm run check` regressions.

---

## 6. Completion Criteria

1. Every investigation writes a complete NDJSON file under `~/.pi/rlm-logs/`
   (override via `logDir`): `run_start` first, `run_end` last on **every** exit
   path (final/no_code/max_turns/budget/error/aborted), all lines valid JSON.
2. A two-level run produces one file containing parent and child turn events,
   RPC events with durations, nested lifecycle events with `root.N` ids, and
   downgrade events — sufficient to replay the investigation offline.
3. Logging failures never affect investigation results (tests 5, 11).
4. `renderCall` shows the prompt at a glance; `renderResult` shows live progress
   while running, a one-glance summary collapsed, and the full timeline + answer
   + log pointer expanded; sessions without details still render.
5. `promptSnippet`/`promptGuidelines` appear in the default system prompt and
   match the built-in tools' tone.
6. `details` carries `runId`, `logPath`, `timeline` (capped), alongside the
   existing fields.
7. All Phase 6 tests pass on the private machine; phases 2-5 suites pass
   **without modification** (68 tests); type-check and lint clean; no new
   `npm run check` regressions.

---

## 7. Locked Phase 6 Decisions

1. Log location `~/.pi/rlm-logs/<runId>.ndjson` (PLAN.md locked decision 2);
   `logDir` tool param overrides the directory. Logging is always on; setup or
   write failure degrades silently (one warning note) — no `enabled` param.
2. One NDJSON file per recursion tree. Events carry `inv` path ids (`"root"`,
   `"root.1"`, `"root.1.1"`, assigned in call order per parent) instead of
   splitting files — the tree shares one budget and one lifecycle, so it shares
   one log.
3. The logger is fire-and-forget with an internal serialized write queue;
   `close()` flushes; post-close events are dropped. It never throws into the
   investigation.
4. Log caps: 20 000 chars for turn texts/code/answer (`capText`), 500-char
   previews + char counts for RPC payloads and prompts. Full payloads are
   reconstructible from the KB itself, not the log.
5. Child turn detail goes to the **log only**; the live UI timeline shows
   nested lifecycle markers (start/end with depth) — concurrent batched children
   would interleave illegibly in a flat live transcript, and the log preserves
   everything.
6. `inv` and `logger` are **optional** `RlmRecursionOptions` fields (defaults
   `"root"` / undefined). This is the semantically correct shape (logger-less
   runs are legitimate), not a back-compat shim; consequently no existing test
   call sites change and `_RLM_HOST_PHASE` stays 5 (host.py untouched).
7. `details` gains `runId`/`logPath`/`timeline`; timeline capped at 200 entries
   x 2 000 chars to bound session-JSONL growth.
8. `renderShell` stays `"default"`; rendering follows the subagent example's
   patterns (Text/Container/Markdown, icon by stop reason, Ctrl+O hint).
9. `done` investigator events are not logged as their own lines —
   `run_end`/`nested_end` carry the terminal state.
10. Jupyter export remains deferred (out of v1, per PLAN.md).
