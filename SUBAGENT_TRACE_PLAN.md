# Implementation Plan: Discoverable & Sweepable Subagent Traces (Solution E)

## Goal

Make subagent cost/token traces discoverable by external session-scanning tools
(e.g. agentsview) while keeping them out of the interactive `--resume` picker, and
add a TTL sweeper that can safely delete child traces because rolled-up totals
survive in the parent session.

## Solution shape (E = C + parent aggregate)

1. Subagent child processes persist real, standard session files into a dedicated
   global directory `~/.pi/agent/sessions/__subagents__/`.
2. Each child links back to its parent via a new `--parent-session` CLI flag.
3. The subagent extension writes a first-class `CustomEntry` (non-LLM) into the
   parent session summarizing every child: child session IDs/paths + rolled-up
   usage totals.
4. A TTL sweeper prunes `__subagents__/` on startup; parent aggregates keep the
   cost numbers even after children are deleted.

## Extension target

The runtime subagent extension lives at **`.pi/extensions/subagents/index.ts`**
(a minimal implementation without chain mode or agent scoping, using
`@mariozechner/pi-coding-agent` imports). All extension-side changes go here.
The `examples/extensions/subagent/` reference implementation is NOT modified.

## Verified facts (from code)

- `SessionHeader.parentSession` + `NewSessionOptions.parentSession` already exist
  and flow through `newSession()`/`create()`/`forkFrom()`. No CLI flag sets them
  (`args.ts` has none).
- `list()` and `listAll()` are both non-recursive:
  - `list()` reads one project dir's `*.jsonl`.
  - `listAll()` scans `sessions/<projectDir>/*.jsonl` (two levels, direct child
    dirs of `sessions/` only).
  - Therefore `sessions/__subagents__/*.jsonl` is a sibling "project" dir:
    **visible to `listAll()`** (and agentsview-style scans), **excluded from a
    specific project's `list()`/`--resume`** because it is a different dir with a
    non-matching cwd.
- `CustomEntry` (`type: "custom"`, `customType`, `data`) does not participate in
  LLM context. Extensions write it via `pi.appendEntry<T>(customType, data)`
  (ExtensionAPI, wired to `SessionManager.appendCustomEntry`).
- The subagent tool factory `export default function (pi: ExtensionAPI)` has `pi`
  in closure scope; the tool's `execute(..., ctx)` also has `ctx.sessionManager`
  (read-only) exposing `getSessionFile()` / `getSessionId()`.
- The extension already parses per-turn usage from the child's `--mode json`
  stream and accumulates it into `AgentResult.usage`. Nothing new needed to
  compute totals.
- `getAgentDir` is exported from the public package; `getSessionsDir` /
  `getDefaultSessionDir` are NOT. The extension needs a path helper.
- Child processes generate their own UUID session id unless `--session-id` is
  passed. To record the child id in the parent aggregate deterministically, the
  extension should pre-generate an id and pass `--session-id`.
- The `.pi` extension's execute function (`buildPiArgs` then `runSubagent`) uses
  `ctx.cwd` but does not currently use `ctx.sessionManager`. The API is available
  and unchanged.

## Design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Persist children? | Yes, standard session files | Discoverable by existing tools; `--resume`-able for debugging |
| Location | `sessions/__subagents__/` (global sibling) | Seen by `listAll()`/agentsview, hidden from per-project `--resume` |
| Parent link | New `--parent-session <path>` flag | Attribution; enables tree reconstruction |
| Parent aggregate | `CustomEntry` `customType: "subagent_trace"` | Cheap totals; survives child cleanup; bidirectional index |
| Child id | Pre-generated, passed via `--session-id` | Parent aggregate can reference exact child files |
| Naming | `--name "<agent>"` (agent name only) | Safe (no task text in metadata); readable in listings |
| Cleanup | TTL sweep on extension startup, default 60 days, env `PI_SUBAGENT_SESSION_TTL_DAYS` | Bounds growth; safe because parent keeps totals |
| Ephemeral parent | Children also ephemeral (no persistence, no aggregate) | Clean privacy story: `--no-session` leaves zero trace anywhere |
| Aggregate child ref | Store `sessionId` only (no path glob) | Simpler; consumers resolve file by matching `*_<id>.jsonl` if needed |

## Changes

### 1. New CLI flag `--parent-session` (packages/coding-agent)

**`src/cli/args.ts`**
- Add `parentSession?: string;` to the `Args` interface (near `sessionId`,
  `session`, `fork`).
- Parse it:
  ```ts
  } else if (arg === "--parent-session" && i + 1 < args.length) {
      result.parentSession = args[++i];
  }
  ```
- Add a help line under the session flags block:
  ```
  --parent-session <path>        Record a parent session link in the new session header
  ```

**`src/main.ts` (`createSessionManager`)**
- Thread `parentSession` into the create path. Today the non-fork/non-resume
  branch ends with:
  ```ts
  return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
  ```
  Change to include `parentSession`:
  ```ts
  return SessionManager.create(cwd, sessionDir, {
      id: parsed.sessionId,
      parentSession: parsed.parentSession,
  });
  ```
- Confirm `SessionManager.create` forwards `options.parentSession` into
  `newSession()` (it does via `NewSessionOptions`). No session-manager change
  needed; if `create` drops the field, add it.
- `--parent-session` only applies when a NEW session is created. With
  `--no-session` it is irrelevant (in-memory). With this plan the subagent stops
  using `--no-session`, so the flag takes effect.

### 2. Export a subagent-session-dir helper (packages/coding-agent)

**`src/config.ts`**
- Add and export:
  ```ts
  export function getSubagentSessionsDir(): string {
      return join(getSessionsDir(), "__subagents__");
  }
  ```
  (Reuses existing `getSessionsDir`. Do not create the dir here; let
  `SessionManager` create it on first write, matching `getDefaultSessionDir`
  behavior. If eager creation is needed for the sweeper, guard with `existsSync`.)

**`src/index.ts`**
- Add `getSubagentSessionsDir` to the `./config.ts` re-export block alongside
  `getAgentDir`.

### 3. Subagent extension: persist children + write parent aggregate

**`.pi/extensions/subagents/index.ts`**

Imports:
- Add `getSubagentSessionsDir` to the `@mariozechner/pi-coding-agent` import.
- Add `import * as crypto from "node:crypto"` for `crypto.randomUUID()` (no new
  npm dep).

`runSubagent` signature/args (function name in `.pi/extensions/`):
- Add params: `subagentDir: string` and `parentSessionFile: string | undefined`.
  Derive `persistChildren` inside the function from `!!parentSessionFile`.
- Replace the spawn args construction in `buildPiArgs`:
  ```ts
  const args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];
  ```
  with (decision 4 — ephemeral parent → ephemeral children):
  ```ts
  const persistChildren = !!parentSessionFile;
  const args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-skills"];
  let childSessionId: string | undefined;
  if (persistChildren) {
      childSessionId = crypto.randomUUID();
      args.push(
          "--session-dir", subagentDir,
          "--session-id", childSessionId,
          "--name", agent.name,
      );
      args.push("--parent-session", parentSessionFile);
  } else {
      args.push("--no-session");
  }
  ```
- `persistChildren` is derived once in `execute`:
  `const parentSessionFile = ctx.sessionManager.getSessionFile();`
  When the parent is ephemeral (in-memory), `getSessionFile()` is undefined, so
  children get `--no-session` too and no aggregate is written.
- Record `childSessionId` on the `AgentResult` (add `sessionId?: string` to
  `AgentResult`). Decision 2: store the id ONLY. The child's filename is
  `<fileTimestamp>_<id>.jsonl` with the timestamp generated child-side; a
  discovery tool resolves the file by matching `*_<id>.jsonl` inside
  `__subagents__/`. No post-exit glob, no absolute path stored.

Concurrency / cwd note:
- `--session-dir __subagents__` is global, not the child's cwd. Children keep
  running in their task `cwd` for tool operations; only session storage is
  redirected. Confirm `--session-dir` does not force the child's `cwd`. (It sets
  storage location only; cwd comes from the spawn `cwd` option which is the
  task's `cwd`, not the session dir.)

Wire the new params through the two call sites in `execute` (single, parallel;
no chain mode in the `.pi` extension). Read once at the top of `execute`:
```ts
const parentSessionFile = ctx.sessionManager.getSessionFile();
const subagentDir = getSubagentSessionsDir();
```
Pass both into every `runSubagent(...)` invocation (directly for single mode and
through the `mapConcurrent` helper for parallel mode). Update `buildPiArgs` to
accept `parentSessionFile` and `subagentDir` and produce the appropriate args.

Parent aggregate (the "E" part):
- After all results for a `subagent` tool call are collected (single or
  parallel), compute rolled-up totals and append one `CustomEntry` to the parent:
  ```ts
  pi.appendEntry("subagent_trace", {
      version: 1,
      mode,                          // "single" | "parallel"
      parentSessionId: ctx.sessionManager.getSessionId(),
      children: results.map(r => ({
          agent: r.agent,
          sessionId: r.sessionId,
          model: r.model,
          exitCode: r.exitCode,
          usage: r.usage,            // input/output/cacheRead/cacheWrite/cost/turns
      })),
      totals: sumUsage(results),     // aggregate across children
  });
  ```
- Add a small `sumUsage(results: AgentResult[]): AgentResult["usage"]` helper.
- Decision 4: only append when `persistChildren` is true (parent has a session
  file). When the parent is ephemeral, children are also ephemeral and there is
  nothing to aggregate — skip the entry. Guard:
  `if (parentSessionFile) pi.appendEntry("subagent_trace", {...});`

Do NOT register an LLM-visible renderer requirement: `CustomEntry` is non-LLM and
the TUI ignores unknown `custom` entries. Optionally register a message renderer
later for nice display; not required for this plan.

### 4. TTL sweeper for `__subagents__/`

**Where:** extension-local startup sweep (decision 3). Runs once per pi startup
when the subagent extension's factory function executes. Not a timer, not
per-subagent-call. If pi never starts, nothing is swept.

**`.pi/extensions/subagents/index.ts`** (inline, not a separate file):
- Add `sweepSubagentSessions(dir: string, maxAgeMs: number)`:
  - `if (!fs.existsSync(dir)) return;`
  - `readdirSync(dir)` → for each `*.jsonl`, `statSync(file).mtimeMs`;
    if `Date.now() - mtimeMs > maxAgeMs`, `unlinkSync(file)`.
  - Wrap each unlink in try/catch; never throw out of the sweeper.
- Trigger once when the extension activates (top of `export default function`),
  fire-and-forget:
  ```ts
  const DEFAULT_TTL_DAYS = 60; // decision 1
  const ttlDays = Number(process.env.PI_SUBAGENT_SESSION_TTL_DAYS) || DEFAULT_TTL_DAYS;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  void Promise.resolve().then(() =>
      sweepSubagentSessions(getSubagentSessionsDir(), ttlMs));
  ```
- TTL configurable via env `PI_SUBAGENT_SESSION_TTL_DAYS` (parse int, fall back
  to 60). A non-positive or non-numeric value falls back to the 60-day default.
  Document in the extension README.
- Safety: sweeper only touches `__subagents__/`; never the user's project session
  dirs. Parent aggregates are untouched, so cost history persists post-sweep.

### 5. Types

- `AgentResult`: add `sessionId?: string;` to track which child session file
  stores this subagent's trace.
- Define a local interface `SubagentTraceEntry` for the aggregate payload shape
  (version, mode, parentSessionId, children[], totals) for self-documentation.

## Documentation

- **`.pi/extensions/subagents/README.md`**: document the new behavior — where
  subagent sessions are stored, the `subagent_trace` parent entry schema (v1),
  the TTL sweeper and its env var (`PI_SUBAGENT_SESSION_TTL_DAYS`), and how
  external tools can discover traces (scan `sessions/__subagents__/`, or read
  parent `subagent_trace` entries for cheap totals).
- **`packages/coding-agent/CHANGELOG.md`** under `## [Unreleased]`:
  - `### Added`: `--parent-session` CLI flag; `getSubagentSessionsDir` export.
  - `### Changed`: subagent extension (`--parent-session` flag) supports
    persisting child sessions to `__subagents__/`, parent-child linkage, and
    `subagent_trace` aggregate entries. TTL sweeper included in extension.
- **`--help` output** already updated via args.ts change.

## Tests

Location: `packages/coding-agent/test/suite/` using `harness.ts` + faux provider.

1. **`--parent-session` flag** (unit, `src/cli/args.ts`): parsing populates
   `Args.parentSession`; and an integration check that a created session's header
   contains `parentSession`.
2. **Aggregate entry**: run the subagent tool (faux provider) with a single task;
   assert the parent session gains one `custom` entry with
   `customType === "subagent_trace"` whose `totals` match the child usage and
   whose `children[0].sessionId` is set.
3. **Location/discovery**: assert child session file lands in `__subagents__/`
   and that `SessionManager.list(projectCwd)` does NOT return it, while
   `SessionManager.listAll()` DOES.
4. **Sweeper**: create fake old + new `.jsonl` files in a temp `__subagents__`,
   run `sweepSubagentSessions` with a TTL, assert only old files removed; assert
   it no-ops on a missing dir and swallows unlink errors.
5. **Cleanup-safety invariant**: after sweeping child files, the parent
   `subagent_trace` entry still reports the totals (numbers survive deletion).

Put any issue-specific regression under
`test/suite/regressions/<issue>-subagent-trace.test.ts` if an issue number exists.

## Verification / commands

- `npm run check` (full output) after code changes; fix all errors/warnings.
- Run the new tests via `./test.sh` (never the raw full vitest suite).
- Manual: run pi interactively, invoke `subagent`, confirm:
  - a file appears in `~/.pi/agent/sessions/__subagents__/`,
  - its header has `parentSession` pointing at the active session,
  - the active session file contains a `subagent_trace` custom entry,
  - `--resume` in the project does not list the child,
  - a cross-project session scan (listAll) does list it.

## Resolved decisions

1. Default TTL: **60 days**, env override `PI_SUBAGENT_SESSION_TTL_DAYS`.
2. Aggregate storage: **child `sessionId` only** (consumers resolve file by
   matching `*_<id>.jsonl`).
3. Sweeper trigger: **extension-local startup sweep** (once per pi startup).
4. Ephemeral parent: **children also ephemeral** — no child persistence, no
   aggregate entry. `--no-session` leaves zero trace anywhere.

## agentsview compatibility

No changes required for the zero-change path:
- `__subagents__/` is a direct child of `sessions/`, so any tool enumerating
  `sessions/*/*.jsonl` (as pi's `listAll()` does) discovers child traces
  automatically. Child files are standard-format sessions.
- Summing per-message `usage` fields works unchanged.

Changes only needed if agentsview wants:
- **Parent/child grouping**: read child header `parentSession`, or the parent's
  `subagent_trace` entry.
- **To read the aggregate**: treat `subagent_trace` as index/metadata, NOT as
  additional spend, to avoid double-counting (child sessions already carry the
  real per-message usage). The `custom` entry has no message usage, so a tool
  that only sums message `usage` will not double-count by default.

agentsview source is not in this repo; verify against its actual scan/sum logic
if parent/child grouping or aggregate consumption is desired.