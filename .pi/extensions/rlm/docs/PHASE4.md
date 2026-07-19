# RLM Extension — Phase 4 Implementation Plan

## Phase 4 Goal

Give the investigator a child model it can delegate to, and make spend a first-class,
shared resource:

- `llm_query(prompt)` / `llm_query_batched(prompts)` builtins — RPC round-trips to a
  cheaper *analyst* model via `complete()`.
- A shared `BudgetTracker` (`budget.ts`) that both the investigator's own `complete()`
  calls and every analyst call charge against. Phase 5's recursion will pass the same
  tracker into nested investigations, so its API must already be sharing-ready.
- The investigator/analyst model split: investigator default `azure-foundry/Kimi-K2.6`
  (unchanged), analyst default `azure-foundry/gpt-5.4-nano`.

Phase 4 does **not** implement (deferred):

- `rlm_query()` / `rlm_query_batched()` recursion, `maxDepth`, downgrade-to-`llm_query`
  at the depth limit (Phase 5)
- NDJSON run logging, rich `renderCall` / `renderResult`, `promptSnippet` /
  `promptGuidelines` (Phase 6)
- Jupyter export (deferred indefinitely)

### Resolved discrepancy (flagged in PHASE3.md §1)

PLAN.md names the analyst default `gpt-5.4-mini` in the body but `gpt-5.4-nano` in the
locked decisions. Per the PHASE3.md note, the locked-decisions section wins:
**`azure-foundry/gpt-5.4-nano`**.

---

## 1. Current State (verified against the code)

- `host.py` — phase-3 host: `_rpc_call()` (strict ID matching, main-thread guard),
  `kb_search`/`kb_read` shims, `FINAL`/`FINAL_VAR`/`SHOW_VARS`, `set_var` message,
  `_RLM_HOST_PHASE = 3`. Adding a builtin = one shim + namespace entry + marker bump.
- `repl.ts` — `PythonRepl`; `RpcHandlers = Record<string, RpcHandler>` set via
  `setRpcHandlers()`. One global `rpcTimeoutMs` (default 60 s) raced against every
  handler. `execTimeoutMs` (default 120 s) is armed in `sendRequest()` and runs
  **continuously**, including while Python is blocked inside `_rpc_call` waiting on a
  TypeScript handler. Two phase-4 problems follow:
  1. A single model call can exceed 60 s; a batched fan-out certainly can.
  2. Time spent in TS handlers burns the exec timeout; a block whose RPCs take > 120 s
     kills the REPL even though nothing is stuck.
- `rpc.ts` — `createRpcHandlers(options: AgentKBOptions)` returns the two KB handlers.
- `investigator.ts` — `runInvestigation()` accumulates `costUsd` locally against
  `opts.maxBudgetUsd`; budget check at top of loop only; `completeFn` injectable.
- `index.ts` — resolves the investigator via `ctx.modelRegistry.find()` +
  `getApiKeyAndHeaders()`, fail-fast on missing model/auth; passes `maxBudgetUsd`
  through; REPL python falls back to `RLM_PYTHON`.
- `test-phase3.ts` — 20 tests, fake `completeFn` (`fakeAssistant(text, costUsd)`
  helper), mock RPC handlers, `RLM_PYTHON` override. Loop tests construct
  `maxBudgetUsd` directly — **they break when `InvestigationOptions` changes** and must
  be updated in this phase.

API surfaces (verified in Phase 3, unchanged): `complete(model, ctx, opts)` resolves
in-band with `stopReason: "error" | "aborted"` instead of throwing; `AssistantMessage`
carries `usage.cost.total`; `UserMessage` needs `timestamp`. `azure-foundry` has
`compat.supportsReasoningEffort: false` — never pass `reasoningEffort` for either
model.

---

## 2. File-by-File Plan

```text
.pi/extensions/rlm/
  budget.ts          NEW: shared BudgetTracker
  host.py            extend: llm_query / llm_query_batched shims, phase marker 4
  repl.ts            extend: per-handler RPC timeout, exec-timeout suspension during RPC
  rpc.ts             extend: llm_query / llm_query_batched handlers (+ concurrency helper)
  prompt.ts          extend: document the new builtins and their cost semantics
  investigator.ts    change: BudgetTracker replaces maxBudgetUsd
  index.ts           change: analyst params/resolution, tracker wiring, details
  test-phase3.ts     update: construct a BudgetTracker where maxBudgetUsd was used
  test-phase4.ts     NEW: deterministic tests for budget, llm builtins, timeouts
  PHASE4.md          this plan
```

`agentkb.ts` needs no changes.

---

## 2.1 `budget.ts` — Shared Budget Tracker (NEW)

```typescript
export class BudgetTracker {
	readonly maxUsd: number;
	/** Guard for models whose registry entry has no cost metadata (cost.total == 0). */
	readonly maxCalls: number;
	private spent = 0;
	private calls = 0;

	constructor(maxUsd: number, maxCalls: number);

	get spentUsd(): number;
	get callCount(): number;
	get remainingUsd(): number;      // max(0, maxUsd - spent)
	exhausted(): boolean;            // spent >= maxUsd || calls >= maxCalls
	/** Charge one completed model call. */
	add(costUsd: number): void;      // spent += costUsd; calls += 1
}
```

Design rules:

- **One tracker per `rlm_query` tool call.** The investigator loop and all analyst
  handlers hold the same instance. Phase 5 hands the same instance to nested
  investigations ("children get whatever the parent has left" falls out for free —
  there is only one pool).
- **Check before launch, charge after completion.** A call that is already in flight
  when the budget trips is allowed to finish and may overshoot `maxUsd`; this matches
  the Phase 3 decision ("a single call can overshoot") and avoids cancelling paid work.
  Concurrent batched siblings each check `exhausted()` immediately before their own
  launch, so a fan-out stops admitting new calls as soon as the pool is dry.
- **`maxCalls` exists because custom `models.json` entries often carry no cost data**,
  making `usage.cost.total` 0 and the USD cap unreachable. The call cap is the backstop
  that keeps a zero-cost-metadata model from fanning out forever. Default 100 per run.
- No async, no locking needed — JS is single-threaded; `add()` calls from interleaved
  handler continuations are serialized by the event loop.

---

## 2.2 `host.py` — `llm_query` Shims

Two new shims, same shape as `kb_search`:

```python
def llm_query(prompt):
    """Ask the analyst LLM a single question. String in, string out. Costs budget."""
    return _rpc_call("llm_query", {"prompt": prompt})


def llm_query_batched(prompts):
    """Ask the analyst LLM many questions concurrently. Returns a list of answer
    strings in the same order. Failed items become '[llm_query error: ...]' strings."""
    return _rpc_call("llm_query_batched", {"prompts": prompts})
```

- Both go into `namespace`, `_RLM_BUILTINS` grows to seven entries,
  `_RLM_HOST_PHASE = 4`.
- No host-side validation beyond what `_rpc_call` already does — argument validation
  lives in the TypeScript handler (consistent with `kb_search`); a bad argument comes
  back as `ok:false` → `RuntimeError` traceback.
- The existing main-thread guard already prevents Python-thread fan-out; batching is
  the sanctioned way to parallelize, exactly as the guard's error message promises.

---

## 2.3 `repl.ts` — Timeout Changes

### 2.3.1 Per-handler RPC timeout

The global `rpcTimeoutMs` (60 s) stays as the default, but a handler registration may
carry its own:

```typescript
export type RpcHandler = (args: unknown) => Promise<unknown> | unknown;

export interface RpcHandlerEntry {
	handler: RpcHandler;
	/** Overrides options.rpcTimeoutMs for this method. */
	timeoutMs?: number;
}

export type RpcHandlers = Record<string, RpcHandler | RpcHandlerEntry>;
```

`setRpcHandlers()` normalizes both shapes into `RpcHandlerEntry` internally;
`handleRpcMessage()` races against the entry's timeout. Plain-function registrations
(everything existing, including `test-phase2.ts`) keep working unchanged.

### 2.3.2 Suspend the exec timeout while an RPC is pending

Time spent inside a TypeScript RPC handler is not Python compute time and must not
count against `execTimeoutMs` (otherwise any block whose model calls take > 120 s
kills the REPL). Mechanics:

- When a valid `rpc` message arrives and `pendingExec` exists:
  `clearTimeout(pendingExec.timeout)`.
- When the matching `rpc_response` has been written and `pendingExec` still exists:
  re-arm `pendingExec.timeout = setTimeout(..., execTimeoutMs)`.

Notes:

- Only one RPC can be in flight (Python's main thread blocks in `_rpc_call`), so a
  simple clear/re-arm is enough — no counter needed. Assert/ignore nothing: if a second
  `rpc` arrives while one is pending, that is already a protocol impossibility and the
  existing strictness applies.
- Re-arming grants a *fresh* `execTimeoutMs` after every RPC, so a block doing many
  RPCs can run far longer than 120 s of wall time. Intended: the exec timeout now
  approximately bounds *Python-side* compute per stretch between RPCs.
- A handler that hangs is still covered: the per-RPC timeout fires, `ok:false` is
  written, the exec timer is re-armed. No coverage hole.
- If the response write is skipped because the REPL failed/closed (existing
  write-after-close guard), `pendingExec` is already gone — do not re-arm.

The known Phase 2 quirk (`close()` while Python is blocked in `_rpc_call` falls back to
the kill timer) remains acceptable; abort still goes through `fail()` → `kill()`.

---

## 2.4 `rpc.ts` — Analyst Handlers

### 2.4.1 Options

```typescript
export interface LlmOptions {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	budget: BudgetTracker;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to complete from pi-ai. */
	completeFn?: CompleteFn;
}

export function createRpcHandlers(kb: AgentKBOptions, llm: LlmOptions): RpcHandlers;
```

One factory, both handler families — `index.ts` calls it once. Constants:

```typescript
const LLM_BATCH_CONCURRENCY = 16;   // locked in PLAN.md
const MAX_BATCH_PROMPTS = 100;
const LLM_RPC_TIMEOUT_MS = 300_000;        // 5 min single call
const LLM_BATCH_RPC_TIMEOUT_MS = 900_000;  // 15 min whole batch
```

The two llm handlers are registered as `RpcHandlerEntry` with these timeouts; the KB
handlers stay plain functions on the 60 s default.

### 2.4.2 Single call core

Shared by both handlers:

```typescript
async function runAnalystCall(llm: LlmOptions, prompt: string): Promise<string>
```

1. If `llm.budget.exhausted()` → throw
   `"llm_query: budget exhausted ($<spent> of $<max>, <n> calls)"`.
2. `msg = await completeFn(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { apiKey, headers, signal })`
   — no system prompt, no `reasoningEffort`, provider-default `maxTokens`. Wrap in
   try/catch for transport throws.
3. `llm.budget.add(msg.usage.cost.total)` — charge even when the reply then turns out
   to be an error? No: charge only on `stopReason` ∈ {`stop`, `length`}. An `"error"`
   reply made no useful spend the API reported reliably; an `"aborted"` one is the
   user's Esc. (Provider-side billing for errored calls is noise we accept.)
4. `stopReason === "error"` → throw with `msg.errorMessage`; `"aborted"` → throw
   `"llm_query aborted"`.
5. Return the concatenated `TextContent` parts (same `assistantText` logic as the
   investigator — export that helper from `investigator.ts` instead of duplicating it).

### 2.4.3 `llm_query` handler

- Validate `prompt` is a non-empty string (after `asRecord`).
- Return `runAnalystCall(llm, prompt)`. Any throw becomes `ok:false` → a normal Python
  `RuntimeError` traceback in the block. The model sees "budget exhausted" as an
  in-REPL error and can react (e.g. go straight to `FINAL()`).

### 2.4.4 `llm_query_batched` handler

- Validate `prompts` is an array, `length <= 100`, every element a non-empty string.
  An empty array returns `[]` without any model call.
- Fan out with a local `mapWithConcurrencyLimit(items, 16, fn)` helper (same pattern
  as the subagent example; small enough to live in `rpc.ts`).
- **Per-item error containment**: each item that throws resolves to the string
  `"[llm_query error: <message>]"` instead of failing the batch — one bad item must not
  discard the spend of its 99 siblings. Budget exhaustion mid-batch therefore shows up
  as error strings for the not-yet-launched tail while completed answers survive.
- Returns `string[]` in input order.

---

## 2.5 `prompt.ts` — Document the New Builtins

Add to the Environment section:

- `llm_query(prompt)` → ask a smaller analyst LLM; string in, string out. The analyst
  sees ONLY the prompt string — no REPL state, no `context`, no KB access — so include
  everything it needs (e.g. paste the relevant text into the prompt).
- `llm_query_batched(prompts)` → up to 16 concurrent analyst calls; returns answers in
  order; failed items come back as `"[llm_query error: ...]"` strings — check before
  trusting.

Add to Rules of thumb:

- Use `llm_query` to summarize/extract from a long document instead of printing it into
  your own context; use `llm_query_batched` to fan out over many documents.
- Analyst calls spend the same budget as your own turns. When a call fails with
  "budget exhausted", stop delegating and finish with `FINAL()`.

`PromptOptions` is unchanged (turn/output caps already flow in).

---

## 2.6 `investigator.ts` — BudgetTracker Replaces `maxBudgetUsd`

- `InvestigationOptions`: drop `maxBudgetUsd: number`, add `budget: BudgetTracker`
  (no backward compatibility, per repo rules).
- Top-of-loop check becomes `opts.budget.exhausted()`; the budget stop message should
  name both dimensions (USD and call count) since either can trip it.
- After each investigator `complete()`: `opts.budget.add(msg.usage.cost.total)`
  (replaces the local `costUsd +=`). Same charge rule as the analyst: charge on
  `stop`/`length`, not on `error`/`aborted`.
- `InvestigationResult.costUsd` reports `opts.budget.spentUsd` — with a shared pool the
  meaningful number is total spend, and in Phase 4 there is exactly one run per pool
  anyway. Document this on the field (Phase 5 inherits the semantics: every nested
  result reports tree-total spend so far).
- Everything else (loop shape, events, capping, abort) is untouched.
- `assistantText()` gets exported for reuse by `rpc.ts` (see 2.4.2).

`test-phase3.ts` update: replace each `maxBudgetUsd: X` with
`budget: new BudgetTracker(X, bigCallCap)`; the budget test's expectations
(stop after turn 2 at 0.30/call against 0.50) are unchanged.

---

## 2.7 `index.ts` — Analyst Wiring

### New params (TypeBox)

```typescript
analystProvider: Type.Optional(Type.String()),   // default "azure-foundry"
analystModel: Type.Optional(Type.String()),      // default "gpt-5.4-nano"
maxLlmCalls: Type.Optional(Type.Number()),       // default 100, integer >= 1
```

(`maxDepth` still joins in Phase 5.)

### Execute flow changes

1. Validate `maxLlmCalls` (positive integer) alongside the existing fail-fast checks.
2. Resolve the analyst exactly like the investigator: `ctx.modelRegistry.find()` →
   hard error naming `provider/model` and `models.json`; `getApiKeyAndHeaders()` →
   hard error on `!ok`. **Fail-fast, not degrade**: a half-working REPL whose
   `llm_query` always errors wastes investigator turns discovering it; symmetric with
   the investigator's handling; on machines without `azure-foundry` the caller already
   has to override the investigator anyway, so overriding the analyst too is no extra
   burden.
3. `const budget = new BudgetTracker(maxBudgetUsd, maxLlmCalls + maxTurns)` — the call
   cap covers the whole pool, so it must leave headroom for the investigator's own
   turns. Simplest correct accounting: one shared cap sized as analyst budget + turn
   budget. (Alternative — separate analyst-only counter — rejected as a second
   mechanism for marginal precision.)
4. `createRpcHandlers(agentkbOptions, { model: analystModel, apiKey, headers, budget, signal })`.
5. `runInvestigation({ ..., budget })` (drop `maxBudgetUsd`).
6. `details`: `costUsd` now comes from `budget.spentUsd` (the result field already
   does), add `modelCalls: budget.callCount`.

---

## 3. Testing Plan — `test-phase4.ts`

Same conventions as `test-phase3.ts`: standalone script, real `PythonRepl`, mock KB
handlers, scripted fake `completeFn`s, `RLM_PYTHON` env override, run via

```text
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase4.ts
```

Build a `fakeLlm(answers: Record<string, string>)` helper: a `CompleteFn` that looks up
the prompt's user message and returns a canned `fakeAssistant`, recording call order
and max observed concurrency (increment a counter on entry, decrement on exit after an
`await setTimeout(10)`, track the high-water mark).

### Unit tests (no REPL)

1. `BudgetTracker`: `exhausted()` flips at `maxUsd`; at `maxCalls`; `remainingUsd`
   floors at 0; `add()` after exhaustion still records (overshoot is visible).
2. `mapWithConcurrencyLimit`: order preserved, cap respected, rejection propagates.

### Host-level tests (exec direct, mock llm handlers)

3. `_RLM_HOST_PHASE == 4`; `_RLM_BUILTINS` has all seven builtins.
4. `llm_query("x")` returns the mock string; printable from Python.
5. `llm_query(123)` (non-string) → traceback contains the validation message.
6. `llm_query_batched(["a","b","c"])` → list in order; `llm_query_batched([])` → `[]`;
   non-list → traceback.
7. Per-item failure: mock handler that throws for prompt `"b"` → result is
   `["A", "[llm_query error: ...]", "C"]`, block completes without traceback.

### Handler-level tests (real `createRpcHandlers` llm side, fake `completeFn`)

8. Single call charges the budget: after one `llm_query`, `spentUsd` grew by the fake
   cost and `callCount == 1`.
9. Budget exhausted before call → handler throws "budget exhausted"; Python sees a
   `RuntimeError`; **no** `completeFn` invocation recorded.
10. Batched concurrency: 40 prompts, recorded high-water mark `<= 16` and `> 1`.
11. Batched budget cut-off: budget allows ~3 calls (fake cost 0.2, max 0.5) → first
    items answered, tail items are budget-error strings, `callCount` stopped growing.
12. Analyst `stopReason: "error"` → item/handler error contains `errorMessage`; no
    budget charge for that call.
13. `stopReason: "length"` reply → returned as text (truncated analyst output is the
    investigator's problem to judge) and **is** charged.

### REPL/timeout integration tests

14. Exec-timeout suspension: `execTimeoutMs: 1_000`, mock `llm_query` handler that
    takes 2 s → block with one `llm_query` call completes successfully (regression for
    2.3.2). Control: a pure-Python `time.sleep(2)` block under the same 1 s exec
    timeout still dies.
15. Per-handler timeout: register a handler with `timeoutMs: 200` that takes 1 s →
    Python gets the timeout `RuntimeError`; the 60 s default did not apply; exec timer
    was re-armed (block can keep running afterwards).

### Loop-level tests (full `runInvestigation` with shared tracker)

16. Shared pool: investigator fake costs 0.2/turn, scripted code calls `llm_query`
    (analyst fake costs 0.2) → tracker reflects both; with `maxUsd 0.5` the run stops
    with `stopReason: "budget"` once turn + analyst spend crosses it.
17. `InvestigationResult.costUsd === budget.spentUsd` on every exit path tested.
18. Abort mid-batch: fire the `AbortController` while a batched call is in flight →
    in-flight `completeFn` sees the signal; run ends `aborted`; no unhandled
    rejections.

### Update `test-phase3.ts`

19. Mechanical: swap `maxBudgetUsd` for `budget: new BudgetTracker(...)`; rerun; all 20
    must stay green.

### Manual / integration

- **Private machine**: full `test-phase4.ts` + rerun `test-phase3.ts` with
  `RLM_PYTHON` (no agentkb, no API keys).
- **Pi end-to-end (corporate machine)**: a question that plausibly needs delegation,
  e.g. `rlm_query("Summarize what the wiki says about X across all related pages")`.
  Verify: `llm_query`/`llm_query_batched` visible in the transcript, both models billed
  (`details.costUsd` > investigator-only baseline, `details.modelCalls` > turns), Esc
  mid-batch aborts cleanly, no orphan Python process.

---

## 4. Edge Cases

| Edge case | Handling |
|---|---|
| Analyst model not in registry | Fail-fast at tool start, same error shape as investigator. |
| Analyst auth fails | Fail-fast, surfaces `auth.error`. |
| `llm_query` with empty/non-string prompt | Handler validation → `ok:false` → `RuntimeError`. |
| Budget exhausted before an analyst call | Throw before `complete()`; Python-visible error; model can still `FINAL()`. |
| Budget trips mid-batch | Already-launched calls finish and are charged; unlaunched tail becomes error strings. |
| Single call overshoots `maxUsd` | Allowed (check-before-launch, charge-after); same as Phase 3. |
| Zero cost metadata in `models.json` | USD cap never trips; `maxCalls` backstop (default 100 + maxTurns) bounds the run. |
| One batched item fails | `"[llm_query error: ...]"` string in its slot; siblings unaffected. |
| `prompts` longer than 100 | Handler validation error — split the batch. |
| Analyst reply `stopReason: "length"` | Returned as text, charged; investigator judges usability. |
| Analyst reply `stopReason: "error"` | Item/handler error with `errorMessage`; not charged. |
| Esc during an analyst call | `signal` → in-band `"aborted"` → handler throws → exec fails → loop maps to `aborted` via `signal?.aborted`. |
| Model call slower than 60 s | Per-handler timeouts: 5 min single, 15 min batch. |
| RPC handler time vs exec timeout | Exec timer suspended while the RPC is pending, re-armed on response (2.3.2). |
| Handler hangs forever | Per-RPC timeout → `ok:false` → exec timer re-armed; nothing leaks. |
| Python threads calling `llm_query` | Existing main-thread guard rejects; batching is the sanctioned fan-out. |

---

## 5. Build Order

1. `budget.ts` + unit tests (tests 1–2 runnable immediately).
2. `repl.ts`: per-handler timeout (`RpcHandlerEntry` normalization), exec-timeout
   suspension. Verify with tests 14–15 early — these are the riskiest changes.
3. `host.py`: two shims, markers → verify by piping JSON lines manually.
4. `investigator.ts`: `BudgetTracker` swap, export `assistantText`; update
   `test-phase3.ts` and rerun it.
5. `rpc.ts`: `LlmOptions`, `runAnalystCall`, both handlers, concurrency helper.
6. `prompt.ts`: builtin docs + rules of thumb.
7. `index.ts`: analyst params/resolution, tracker construction, handler wiring,
   `details.modelCalls`.
8. `test-phase4.ts`: remaining tests; iterate until green on the private machine
   (`RLM_PYTHON` override).
9. Manual Pi test on the corporate machine (tmux per CLAUDE.md), then type-check +
   biome via the temporary-config approach from Phases 2/3 (the `.pi/` tree is outside
   the root tsconfig/biome includes; expect only the known pre-existing `npm run check`
   failures).

---

## 6. Completion Criteria

1. All `test-phase4.ts` tests pass on the private machine; the updated
   `test-phase3.ts` stays green.
2. One shared `BudgetTracker` demonstrably bounds investigator + analyst spend
   together (test 16), and `maxCalls` bounds zero-cost-metadata runs.
3. A REPL block whose `llm_query` calls take longer than `execTimeoutMs` survives
   (timer suspension verified, test 14), and a hung handler still cannot wedge the
   run (test 15).
4. `llm_query_batched` respects the 16-way cap, preserves order, and contains
   per-item failures.
5. Pi end-to-end on the corporate machine: an investigation that uses
   `llm_query`/`llm_query_batched`, both models resolved from the registry
   (`Kimi-K2.6` + `gpt-5.4-nano`), accurate `details.costUsd`/`details.modelCalls`,
   clean Esc abort, no orphan processes.
6. Type-check and lint clean for the extension files (temporary-config approach);
   no new `npm run check` regressions.

---

## 7. Locked Phase 4 Decisions

1. Analyst default: `azure-foundry/gpt-5.4-nano` (PLAN.md locked-decisions section
   wins over the body's `gpt-5.4-mini` mention).
2. Analyst resolution is fail-fast at tool start, symmetric with the investigator.
3. Batched error containment: per-item `"[llm_query error: ...]"` strings, never a
   whole-batch failure.
4. Concurrency cap 16 and batch-size cap 100 are constants, not tool params.
5. RPC timeouts: 5 min `llm_query`, 15 min `llm_query_batched`, via per-handler
   timeout entries; KB handlers stay on the 60 s default.
6. Exec timeout is suspended while an RPC is pending and re-armed per response; it
   bounds Python-side compute, not handler time.
7. Charge on `stop`/`length`, never on `error`/`aborted`; check budget before launch,
   charge after completion; overshoot by in-flight calls is accepted.
8. `BudgetTracker` carries a call-count backstop (`maxLlmCalls` param, default 100,
   plus `maxTurns` headroom) against zero-cost model metadata.
9. No analyst system prompt and no `llm_query(prompt, system=...)` parameter in
   Phase 4; the prompt string is the entire analyst input.
