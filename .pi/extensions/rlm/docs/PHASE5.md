# RLM Extension — Phase 5 Implementation Plan

## Phase 5 Goal

Make the investigation recursive: an investigator can spawn nested investigations that
get their own REPL and their own KB context but spend the parent's budget pool.

- `rlm_query(prompt, context=None)` / `rlm_query_batched(prompts, contexts=None)`
  builtins — RPC round-trips that run a full nested `runInvestigation()` in a fresh
  Python REPL.
- `maxDepth` (default 2, locked in PLAN.md). An `rlm_query` issued by an investigation
  already at the depth limit silently downgrades to a single `llm_query` analyst call.
- Shared budget: the existing `BudgetTracker` instance is handed to every nested run
  unchanged — "children get whatever the parent has left" falls out for free (Phase 4
  designed the tracker for exactly this).
- Nested investigations are driven by the **analyst** model (`azure-foundry/gpt-5.4-nano`),
  not the top-level investigator model. This is locked in PLAN.md ("Analyst
  (`llm_query`, depth >= 1 `rlm_query`)") and means `rpc.ts` already holds everything
  needed to run a child: the analyst `Model` + auth are in `LlmOptions`.

Phase 5 does **not** implement (deferred):

- NDJSON run logging, rich `renderCall` / `renderResult`, `promptSnippet` /
  `promptGuidelines` (Phase 6)
- Jupyter export (deferred indefinitely)

---

## 1. Current State (verified against the code)

- `host.py` — phase-4 host: `_rpc_call()` (strict ID matching, main-thread guard),
  `kb_search`/`kb_read`/`llm_query`/`llm_query_batched` shims, `FINAL`/`FINAL_VAR`/
  `SHOW_VARS`, `set_var` message, `_RLM_HOST_PHASE = 4`, seven-entry `_RLM_BUILTINS`.
  Adding a builtin = one shim + namespace entry + marker bump.
- `repl.ts` — `RpcHandlerEntry { handler, timeoutMs? }` with per-handler timeout;
  exec-timeout suspension while an RPC is pending (cleared on `rpc` arrival, re-armed
  after the `rpc_response` is written). **No changes needed in Phase 5** — a nested
  investigation is just a long-running RPC handler from the parent REPL's point of
  view, and the suspension machinery already covers it. Each child gets its own
  `PythonRepl` instance with its own pipes, so there is no protocol interleaving
  between parent and child.
- `rpc.ts` — `createRpcHandlers(kb: AgentKBOptions, llm: LlmOptions): RpcHandlers`
  returns the two KB handlers (plain, 60 s default timeout) and the two llm handlers
  (entries at 5 min / 15 min). `runAnalystCall()` does budget pre-check → `complete()`
  → charge-on-`stop`/`length` → `assistantText()`. `mapWithConcurrencyLimit()` is
  exported. Phase 5 extends this file.
- `investigator.ts` — `runInvestigation()` is already fully reusable for nested runs:
  it takes `repl`, `model`, auth, `budget`, `signal`, injectable `completeFn`, and has
  no top-level-only assumptions. `InvestigationResult.costUsd` already documents the
  Phase 5 tree-total semantics. **No changes needed** (verify during implementation).
- `budget.ts` — `BudgetTracker` is sharing-ready by design. **No changes needed.**
- `agentkb.ts` — `kbSearch()` is directly callable from TypeScript; the nested runner
  reuses it for child context searches exactly like `index.ts` does for the top level.
  **No changes needed.**
- `prompt.ts` — `buildSystemPrompt(opts)` with `contextCount`/`contextNote`/`maxTurns`/
  `outputCapChars`. Phase 5 adds the rlm builtin docs and two new options.
- `index.ts` — resolves investigator + analyst fail-fast, builds one `BudgetTracker`
  (`maxBudgetUsd`, `maxLlmCalls + maxTurns`), calls `createRpcHandlers(agentkbOptions,
  llmOptions)`, runs the investigation, reports `details.modelCalls`.
- Tests: `test-phase2.ts` (13), `test-phase3.ts` (20), `test-phase4.ts` (18) all green
  on the private machine with `RLM_PYTHON`. `test-phase4.ts` and
  `test-phase2-agentkb.ts` call the two-argument `createRpcHandlers` — **they break
  when the signature changes** and must be updated. The phase-marker assertions in all
  three suites must be bumped to 5.

API surfaces (verified in Phases 3–4, unchanged): `complete()` resolves in-band with
`stopReason: "error" | "aborted"`; `azure-foundry` has
`compat.supportsReasoningEffort: false` — never pass `reasoningEffort`.

---

## 2. File-by-File Plan

```text
.pi/extensions/rlm/
  host.py                 extend: rlm_query / rlm_query_batched shims, phase marker 5
  rpc.ts                  extend: RlmRecursionOptions, runNestedRlmQuery, both handlers
  prompt.ts               extend: rlm builtin docs, contextFromParent / canRecurse
  index.ts                change: maxDepth param, recursion wiring, details.nestedRuns
  test-phase4.ts          update: three-argument createRpcHandlers
  test-phase2-agentkb.ts  update: three-argument createRpcHandlers
  test-phase2/3/4.ts      update: phase marker expectation -> 5
  test-phase5.ts          NEW: deterministic recursion tests
  PHASE5.md               this plan
```

`repl.ts`, `investigator.ts`, `budget.ts`, `agentkb.ts` need no changes.

---

## 2.1 `host.py` — `rlm_query` Shims

Two new shims, same shape as the Phase 4 pair:

```python
def rlm_query(prompt, context=None):
    """Run a nested investigation in its own REPL with its own KB context.
    Returns the nested run's final answer string. Pass context (a list) to hand
    it your own hits/snippets; otherwise it runs its own initial kb_search.
    Spends the shared budget. Downgrades to llm_query at the depth limit."""
    return _rpc_call("rlm_query", {"prompt": prompt, "context": context})


def rlm_query_batched(prompts, contexts=None):
    """Run up to 4 nested investigations concurrently. Returns a list of answer
    strings in input order. contexts, if given, must be a list of the same
    length (each item a list or None). Failed items become
    '[rlm_query error: ...]' strings."""
    return _rpc_call("rlm_query_batched", {"prompts": prompts, "contexts": contexts})
```

- Both go into `namespace`, `_RLM_BUILTINS` grows to nine entries,
  `_RLM_HOST_PHASE = 5`.
- No host-side validation (consistent with `kb_search`/`llm_query`); argument
  validation lives in the TypeScript handler.
- A non-JSON-serializable `context` argument (e.g. a `set`) makes `json.dumps` inside
  `_send_protocol` raise **before anything is written**, so the protocol stream stays
  intact and the block gets a normal traceback. Verify with a test; no code change
  needed.
- The main-thread guard already rejects Python-thread fan-out; `rlm_query_batched` is
  the sanctioned parallelism.

---

## 2.2 `rpc.ts` — Nested Investigation Runner and Handlers

The runner lives in `rpc.ts` (not a new module): it must call `createRpcHandlers`
recursively to wire the child REPL, and `createRpcHandlers` must reference the runner
from the `rlm_query` handlers — same module avoids an import cycle. `rpc.ts` gains
top-level imports of `PythonRepl`, `runInvestigation`, `buildSystemPrompt`, `capText`,
and `kbSearch` (none of those modules import `rpc.ts`, so no cycle).

### 2.2.1 Options

```typescript
export interface RlmRecursionOptions {
	/** Depth of the investigation that owns this handler set; 0 = top level. */
	depth: number;
	/** An rlm_query issued at depth >= maxDepth downgrades to llm_query. */
	maxDepth: number;
	/** Python binary for nested REPL hosts (same resolution as the top level). */
	replPythonPath: string;
	/** Per-child turn cap; index.ts passes the tool's maxTurns through. */
	maxTurns: number;
	outputCapChars: number;
	/** Defaults for a child's initial context search. */
	k: number;
	scope: string;
	/** Injectable for tests; defaults to kbSearch from agentkb.ts. */
	kbSearchFn?: typeof kbSearch;
	/** Child-investigator complete(); separate from llm.completeFn so tests can
	 * script the child investigator and the analyst independently. Defaults to
	 * the real complete(). */
	completeFn?: CompleteFn;
	/** Counts real (non-downgraded) nested runs across the whole tree. */
	stats?: { nestedRuns: number };
	/** Lifecycle notifications for the parent transcript. */
	onNested?: (ev: {
		phase: "start" | "end";
		depth: number;
		prompt: string;
		stopReason?: string;
		turns?: number;
	}) => void;
}

export function createRpcHandlers(
	kb: AgentKBOptions,
	llm: LlmOptions,
	rlm: RlmRecursionOptions,
): RpcHandlers;
```

Third **required** argument — no back-compat, per repo rules; the two existing call
sites in tests are updated in this phase. Constants:

```typescript
const RLM_BATCH_CONCURRENCY = 4;            // locked in PLAN.md
const MAX_RLM_BATCH_PROMPTS = 20;
const RLM_RPC_TIMEOUT_MS = 1_200_000;       // 20 min single nested run
const RLM_BATCH_RPC_TIMEOUT_MS = 3_600_000; // 60 min whole batch
```

A nested run is bounded by `maxTurns` model calls plus REPL work, each of which can
take minutes; 20 min single is headroom, not an expectation. The batch timeout covers
20 queued runs through a 4-wide window. Both ride on the existing per-handler-timeout
machinery; the parent's exec timer is already suspended while the RPC is pending.

### 2.2.2 Downgrade prompt composition

At the depth limit, `rlm_query(prompt, context)` becomes one analyst call. The parent
passed `context` deliberately, so fold it in rather than dropping it:

```typescript
function composeDowngradePrompt(prompt: string, context: unknown): string {
	if (context === null || context === undefined) return prompt;
	// context arrived as parsed JSON, so JSON.stringify cannot fail here.
	return `Context (from the parent investigation):\n${capText(JSON.stringify(context), 8_000)}\n\nQuestion: ${prompt}`;
}
```

`capText` (head+tail, exported by `investigator.ts` since Phase 3) keeps a huge
context list from blowing up the analyst prompt.

### 2.2.3 Single nested run core

```typescript
async function runNestedRlmQuery(
	kb: AgentKBOptions,
	llm: LlmOptions,
	rlm: RlmRecursionOptions,
	prompt: string,
	context: unknown,
): Promise<string>
```

1. **Budget pre-check** (same rule as `runAnalystCall`): if `llm.budget.exhausted()`
   → throw `"rlm_query: budget exhausted ($<spent> of $<max>, <n> calls)"`. Checked
   before the depth check so an exhausted pool never spawns anything.
2. **Depth check**: if `rlm.depth >= rlm.maxDepth` → return
   `runAnalystCall(llm, composeDowngradePrompt(prompt, context))`. Silent downgrade,
   per PLAN.md. With `maxDepth: 0` every `rlm_query` downgrades, which makes the
   param double as a recursion kill switch.
3. **Child context**:
   - `context` is an array → use it verbatim (`contextFromParent: true`).
   - `context` is `null`/`undefined` → `(rlm.kbSearchFn ?? kbSearch)(kb, prompt,
     rlm.k, rlm.scope)`. On failure: empty context + capped `contextNote`, same
     graceful degradation as the top level in `index.ts`.
4. `rlm.stats.nestedRuns += 1` (if present); emit `onNested({ phase: "start",
   depth: childDepth, prompt })` where `childDepth = rlm.depth + 1`.
5. **Spawn child REPL**: `new PythonRepl({ pythonPath: rlm.replPythonPath,
   signal: llm.signal })`; `setRpcHandlers(createRpcHandlers(kb, llm,
   { ...rlm, depth: childDepth }))` — the recursion step; budget and signal flow
   through `llm` unchanged. `await repl.ready()`; `await repl.setVar("context", hits)`.
6. **Run**: `runInvestigation({ question: prompt, systemPrompt: buildSystemPrompt({
   contextCount, contextNote, contextFromParent, canRecurse: childDepth < rlm.maxDepth,
   maxTurns: rlm.maxTurns, outputCapChars: rlm.outputCapChars }), repl,
   model: llm.model, apiKey: llm.apiKey, headers: llm.headers, maxTurns: rlm.maxTurns,
   budget: llm.budget, outputCapChars: rlm.outputCapChars, signal: llm.signal,
   completeFn: rlm.completeFn })`. The child investigator **is the analyst model** —
   locked in PLAN.md; no second model resolution needed.
7. Emit `onNested({ phase: "end", ... })` with `stopReason` and `turns`.
8. **Result mapping**:
   - `"final"` / `"no_code"` / `"max_turns"` / `"budget"` → return `result.answer`.
     The best-effort stop notes (`[Investigation stopped: ...]`) are informative
     strings the parent can read and react to — same philosophy as the in-REPL
     "budget exhausted" error from `llm_query`.
   - `"error"` → throw `"rlm_query: nested investigation failed: <answer>"` →
     `ok:false` → parent-visible `RuntimeError`.
   - `"aborted"` → throw `"rlm_query aborted"` (the parent loop independently ends as
     `aborted` via its own signal checks).
9. **`finally`**: `await repl.close()` — no orphan child processes on any path.

### 2.2.4 `rlm_query` handler

Registered as an entry with `timeoutMs: RLM_RPC_TIMEOUT_MS`. Validation after
`asRecord`:

- `prompt`: non-empty string.
- `context`: `null`/`undefined` or an array (the namespace contract says `context` is
  a list; enforce it). Anything else → validation error → `RuntimeError`.

Then `return runNestedRlmQuery(kb, llm, rlm, prompt, context)`.

### 2.2.5 `rlm_query_batched` handler

Registered with `timeoutMs: RLM_BATCH_RPC_TIMEOUT_MS`. Validation:

- `prompts`: array; `[]` → `[]` without any work; length `<= 20`; every element a
  non-empty string.
- `contexts`: `null`/`undefined`, or an array of exactly `prompts.length` where each
  element is `null` or an array. A length mismatch is a whole-batch validation error
  (it is a calling bug, not an item failure).

Fan out with the existing `mapWithConcurrencyLimit(prompts, RLM_BATCH_CONCURRENCY, ...)`.
Per-item error containment, same as `llm_query_batched`: a throwing item resolves to
`"[rlm_query error: <message>]"` instead of failing the batch — one bad child must not
discard its siblings' completed (and paid-for) work. At most 4 child Python processes
exist at a time.

---

## 2.3 `prompt.ts` — Document Recursion

`PromptOptions` gains:

```typescript
/** True when the context list was handed down by a parent investigation. */
contextFromParent?: boolean;
/** False when rlm_query at this depth silently downgrades to llm_query. */
canRecurse: boolean;
```

- `contextFromParent` switches the `context` description line: "provided by the parent
  investigation" instead of "from an initial knowledge-base search" (the current
  wording would be wrong for handed-down context).
- Environment section, new entries:
  - `rlm_query(prompt, context=None)` → run a nested investigator with its own REPL
    and its own KB context; returns its final answer string. Pass `context` (a list)
    to hand over your own hits/snippets; otherwise it runs its own `kb_search`. The
    nested run's turns and analyst calls all spend YOUR shared budget.
  - `rlm_query_batched(prompts, contexts=None)` → up to 4 concurrent nested
    investigations; answers in input order; failed items come back as
    `"[rlm_query error: ...]"` strings — check before trusting.
  - When `canRecurse` is false, append: "At this depth, rlm_query is automatically
    downgraded to a single llm_query call — prefer llm_query directly."
- Rules of thumb additions:
  - Use `rlm_query` for a sub-question that needs its own searching and reading; use
    `llm_query` when you already have the text and just need it transformed.
  - Nested runs are expensive (many model calls each). Batch a few well-chosen
    sub-questions rather than fanning out broadly.

`index.ts` passes `canRecurse: maxDepth > 0` and `contextFromParent: false` for the
top level.

---

## 2.4 `index.ts` — Recursion Wiring

### New param (TypeBox)

```typescript
maxDepth: Type.Optional(Type.Number()),   // default 2, integer >= 0
```

Validate: integer, `>= 0` (0 = recursion disabled, every `rlm_query` downgrades).

### Execute flow changes

1. `const stats = { nestedRuns: 0 };`
2. Build the recursion options and pass them as the third `createRpcHandlers`
   argument:
   ```typescript
   createRpcHandlers(agentkbOptions, llmOptions, {
   	depth: 0,
   	maxDepth,
   	replPythonPath: params.pythonPath ?? process.env.RLM_PYTHON ?? DEFAULT_AGENTKB_PYTHON,
   	maxTurns,
   	outputCapChars: OUTPUT_CAP_CHARS,
   	k,
   	scope: params.scope ?? DEFAULT_SCOPE,
   	stats,
   	onNested,
   })
   ```
   `replPythonPath` reuses the exact expression already used for the top-level REPL —
   hoist it into a local so the two cannot drift.
3. `onNested` pushes one transcript line per event so live progress shows the tree:
   `[depth 1 rlm_query started: <prompt capped ~120 chars>]` /
   `[depth 1 rlm_query finished: <stopReason>, <turns> turns]`, followed by the usual
   `onUpdate`. Interleaving from concurrent batched children is accepted — Phase 6
   owns proper rendering.
4. Top-level `buildSystemPrompt` call gains `canRecurse: maxDepth > 0`.
5. `details` gains `nestedRuns: stats.nestedRuns` (add to `RlmQueryDetails`).
6. Budget construction is unchanged: `new BudgetTracker(maxBudgetUsd, maxLlmCalls +
   maxTurns)`. Child investigator turns charge the same pool and consume the same call
   cap — that is the point of the backstop, not a bug. Document this on the
   `maxLlmCalls` param description ("covers analyst calls and nested-investigation
   turns").

---

## 3. Testing Plan — `test-phase5.ts`

Same conventions as `test-phase4.ts`: standalone script, real `PythonRepl`s
(parent AND children — the private machine spawns them all via `RLM_PYTHON`), scripted
fake `CompleteFn`s, injectable `kbSearchFn`, run via

```text
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase5.ts
```

Two scripted fakes per test where needed: one for child investigators
(`rlm.completeFn`, returns fenced code / `FINAL()` replies) and one for the analyst
(`llm.completeFn`, returns plain answers). Both record their call logs.

### Host-level tests (exec direct, mock rlm handlers)

1. `_RLM_HOST_PHASE == 5`; `_RLM_BUILTINS` has all nine builtins.
2. `rlm_query("x")` round-trips through a mock handler; `rlm_query("x", context=[...])`
   passes the context through; printable from Python.
3. `rlm_query(123)` and `rlm_query("x", context="not a list")` → tracebacks containing
   the validation messages.
4. `rlm_query_batched(["a","b"])` → list in order; `rlm_query_batched([])` → `[]`;
   `contexts` length mismatch → traceback.
5. Non-JSON-serializable context: `rlm_query("x", context={1,2})` → traceback in the
   block, **and the REPL still works afterwards** (protocol stream not corrupted).

### Runner-level tests (real `runNestedRlmQuery` via the handlers, fake completeFns)

6. Nested happy path: parent block calls `rlm_query("sub")`; child fake scripts one
   `FINAL("child answer")` turn → parent receives `"child answer"`;
   `stats.nestedRuns == 1`; child REPL closed (a subsequent parent exec still works).
7. Parent-provided context: `rlm_query("sub", context=[{"path": "x", "snippet": "y"}])`
   → child fake's system prompt says "provided by the parent investigation"; a child
   turn printing `len(context)` observes `1`; `kbSearchFn` never called.
8. Fresh child context: `rlm_query("sub")` with `kbSearchFn` returning two hits →
   `kbSearchFn` called with the child prompt and the configured `k`/`scope`; child
   sees `len(context) == 2`.
9. Child search failure: `kbSearchFn` throws → child still runs; its system prompt
   carries the failure note; empty context preloaded.
10. Depth downgrade: handlers built with `depth == maxDepth` → `rlm_query` returns the
    analyst fake's answer; child-investigator fake never called; no child REPL
    spawned (`kbSearchFn` not called either); passed context folded into the analyst
    prompt (assert the analyst fake saw "Context (from the parent investigation)").
11. `maxDepth: 0` → top-level `rlm_query` downgrades immediately (kill switch).
12. Budget pre-check: exhausted tracker → `rlm_query` throws "budget exhausted";
    Python sees `RuntimeError`; neither fake invoked.
13. Shared pool across the tree: parent turns at 0.2/call, child turns at 0.2/call,
    `maxUsd 0.5` → the child's spend trips the shared budget; the child stops with a
    `[Investigation stopped: budget exhausted ...]` answer string that the parent
    receives; tree-total `budget.spentUsd` reflects both levels.
14. Child `stopReason: "error"` (scripted in-band error reply) → handler throws →
    parent block gets a `RuntimeError` traceback containing "nested investigation
    failed".
15. Batched: 6 prompts, concurrency high-water `<= 4` and `> 1` (track via the child
    fake), answers in input order, one scripted-to-fail item contained as
    `"[rlm_query error: ...]"` while siblings survive.
16. Abort mid-nested-run: fire the `AbortController` while a child is mid-investigation
    → parent run ends `aborted`, no unhandled rejections (counter on
    `process.on("unhandledRejection")`), no orphan processes (both REPLs' `close()`
    resolve).

### Loop-level test (full two-level `runInvestigation`)

17. End-to-end recursion: top-level fake investigator writes a block calling
    `rlm_query("sub")` then `FINAL(f"got: {answer}")`; child fake FINALs →
    top-level result embeds the child answer; `costUsd === budget.spentUsd` covers
    both levels; `stats.nestedRuns == 1`; `done` events fire at both levels.

### Update existing suites

18. `test-phase4.ts` / `test-phase2-agentkb.ts`: add the third `createRpcHandlers`
    argument (minimal `RlmRecursionOptions` with `depth: 0`, `maxDepth: 0` so nothing
    recurses, plus a child `completeFn` that throws if ever reached). Phase-marker
    expectations in `test-phase2.ts` / `test-phase3.ts` / `test-phase4.ts` → 5. All
    51 existing tests must stay green.

### Manual / integration

- **Private machine**: full `test-phase5.ts` + rerun phases 2–4 with `RLM_PYTHON`
  (no agentkb, no API keys).
- **Pi end-to-end (corporate machine)**: a question that decomposes into independent
  sub-questions, e.g. `rlm_query("Compare what the wiki says about X and Y; cover
  setup, limitations, and ownership for each")`. Verify: `rlm_query`/
  `rlm_query_batched` visible in the transcript with depth markers, child runs use
  `gpt-5.4-nano`, `details.nestedRuns >= 1`, `details.costUsd` covers the tree,
  Esc mid-tree kills every Python process (check Task Manager), depth-2 `rlm_query`
  downgrades silently.
- Rerun `RLM_AGENTKB_TESTS=1` integration tests for the updated wiring.

---

## 4. Edge Cases

| Edge case | Handling |
|---|---|
| `rlm_query` at `depth >= maxDepth` | Silent downgrade to one analyst call; passed context folded into the prompt (capped at 8 000 chars). |
| `maxDepth: 0` | Every `rlm_query` downgrades — recursion kill switch. |
| Budget exhausted before a nested run | Pre-check throws before any spawn/search; parent-visible `RuntimeError`; model can still `FINAL()`. |
| Budget trips inside a child | Child stops with `stopReason: "budget"`; its best-effort answer string is returned to the parent (not an error). |
| Child investigation `stopReason: "error"` | Handler throws "nested investigation failed: ..." → parent traceback. |
| Child ends `no_code` / `max_turns` | Its answer/stop-note string is returned; the parent judges usability. |
| Child REPL spawn failure (bad python path) | `ready()` rejects → handler throws → parent traceback; `finally` close is a no-op; budget untouched. |
| Non-JSON-serializable `context` argument | `json.dumps` in `_send_protocol` raises before writing; clean traceback; protocol intact. |
| `contexts` length mismatch in batched | Whole-batch validation error (caller bug, not an item failure). |
| One batched child fails | `"[rlm_query error: ...]"` in its slot; siblings unaffected. |
| More than 20 batched prompts | Validation error — split the batch. |
| Esc mid-tree | One shared `signal`: every `PythonRepl` (parent + children) kills its process; in-flight `complete()` calls abort in-band; handlers throw; parent loop maps to `aborted`. |
| Nested run slower than 60 s | Per-handler timeouts: 20 min single, 60 min batch; parent exec timer is suspended throughout (Phase 4 machinery). |
| Handler timeout fires mid-child | `Promise.race` drops the handler; the child REPL is NOT leaked — the runner's `finally` close still runs when the orphaned promise settles or the signal fires. Verify in test 16's cleanup assertions. |
| Child calling `rlm_query` again | Works until `depth == maxDepth` (default 2: depth 0 → 1 → 2 → downgrade). |
| Parent REPL during a nested run | Blocked in `_rpc_call` on its own stdin; child traffic is on separate pipes — no interleaving possible. |
| Many abort listeners on one signal | Up to 4 children + parent each add one listener; removed in `finishClose()`; far below any listener warning threshold. |
| Zero cost metadata | The shared `maxCalls` backstop (`maxLlmCalls + maxTurns`) bounds the whole tree, including child turns. |

---

## 5. Build Order

1. `host.py`: two shims, marker 5, nine builtins → verify by piping JSON lines
   manually.
2. `prompt.ts`: `contextFromParent` / `canRecurse` + builtin docs (small, no deps).
3. `rpc.ts`: `RlmRecursionOptions`, `composeDowngradePrompt`, `runNestedRlmQuery`,
   both handlers, constants. This is the riskiest piece — get tests 6–14 running
   early.
4. Update `test-phase4.ts` / `test-phase2-agentkb.ts` call sites + phase markers in
   the three existing suites; rerun all of them.
5. `index.ts`: `maxDepth` param + validation, recursion wiring, `onNested` transcript
   lines, `details.nestedRuns`, `canRecurse` for the top-level prompt.
6. `test-phase5.ts`: remaining tests; iterate until green on the private machine
   (`RLM_PYTHON` override).
7. Manual Pi test on the corporate machine (tmux per CLAUDE.md), then type-check +
   biome via the temporary-config approach from Phases 2–4 (the `.pi/` tree is outside
   the root tsconfig/biome includes; expect only the known pre-existing
   `npm run check` failures).

---

## 6. Completion Criteria

1. All `test-phase5.ts` tests pass on the private machine; the updated phase 2/3/4
   suites stay green (51 existing tests).
2. A two-level investigation demonstrably shares one budget pool (test 13) and one
   call-count backstop; `costUsd` reports tree-total spend on every exit path.
3. Depth limiting works: children recurse up to `maxDepth`, downgrade silently at the
   limit, and `maxDepth: 0` disables recursion entirely.
4. `rlm_query_batched` respects the 4-way cap, preserves order, and contains per-item
   failures; at most 4 child Python processes exist at any time.
5. Esc aborts the whole tree: no orphan Python processes, no unhandled rejections.
6. Pi end-to-end on the corporate machine: a real question that spawns at least one
   nested run; children driven by `gpt-5.4-nano`; `details.nestedRuns`,
   `details.costUsd`, `details.modelCalls` consistent; clean abort.
7. Type-check and lint clean for the extension files (temporary-config approach); no
   new `npm run check` regressions.

---

## 7. Locked Phase 5 Decisions

1. Nested investigations (depth >= 1) are driven by the **analyst model**
   (`azure-foundry/gpt-5.4-nano`), per PLAN.md's model-selection table. No separate
   child-model params in Phase 5.
2. `maxDepth` default 2 (PLAN.md locked decisions); integer >= 0; 0 disables
   recursion. Downgrade condition: an `rlm_query` issued at `depth >= maxDepth`
   becomes one `llm_query` analyst call, silently.
3. On downgrade, a passed `context` is folded into the analyst prompt (JSON, capped
   at 8 000 chars) — the parent passed it deliberately; dropping it would be a silent
   behavior change.
4. `rlm_query` returns the child's answer **string** (consistent with `llm_query` and
   the article). Child stop reasons `final`/`no_code`/`max_turns`/`budget` all return
   the (possibly stop-note-prefixed) answer; `error` and `aborted` throw.
5. Concurrency cap 4 (locked in PLAN.md) and batch-size cap 20 are constants, not
   tool params.
6. RPC timeouts: 20 min `rlm_query`, 60 min `rlm_query_batched`, via per-handler
   timeout entries.
7. The shared `BudgetTracker` instance is passed down unchanged; one pool, one call
   cap (`maxLlmCalls + maxTurns`) for the whole tree. Check-before-launch,
   charge-after-completion, overshoot accepted — all inherited from Phase 4.
8. The nested runner lives in `rpc.ts` (`runNestedRlmQuery`), because it and
   `createRpcHandlers` are mutually recursive; a separate module would create an
   import cycle.
9. `createRpcHandlers` takes a third required `RlmRecursionOptions` argument; the two
   existing test call sites are updated, no back-compat shim.
10. Child context: parent-provided list wins; otherwise a fresh `kbSearch` with the
    tool's `k`/`scope` defaults; search failure degrades to empty context + prompt
    note, mirroring the top level.
11. No new repl.ts machinery: nested runs ride entirely on the Phase 4 per-handler
    timeouts and exec-timeout suspension.
