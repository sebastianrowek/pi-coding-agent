# Phase 4 Implementation Notes

Status of the Phase 4 implementation (llm_query builtins + shared BudgetTracker + investigator/analyst model split, per PHASE4.md).

## What was built

- `budget.ts` (new) — `BudgetTracker(maxUsd, maxCalls)` with `spentUsd`, `callCount`, `remainingUsd` (floored at 0), `exhausted()` (either dimension), `add()` (still records after exhaustion so overshoot stays visible). One instance per `rlm_query` call, shared by the investigator loop and all analyst handlers. Check-before-launch, charge-after-completion; in-flight calls may overshoot `maxUsd`.
- `host.py` — `llm_query` / `llm_query_batched` shims (same `_rpc_call` shape as `kb_search`; argument validation lives in the TS handler), `_RLM_HOST_PHASE = 4`, seven-entry `_RLM_BUILTINS`.
- `repl.ts` — `RpcHandlerEntry { handler, timeoutMs? }`; `RpcHandlers` accepts plain functions or entries (`setRpcHandlers` normalizes, so all existing plain-function registrations keep working). `handleRpcMessage` races against the entry's timeout. Exec-timeout suspension: the pending exec's timer is cleared when an `rpc` message arrives and re-armed fresh (`rearmExecTimeout`) after the `rpc_response` is written — including the unknown-method and handler-timeout paths; if the REPL failed/closed meanwhile, `pendingExec` is gone and re-arm is a no-op. The exec timeout now bounds Python-side compute per stretch between RPCs, not handler time.
- `rpc.ts` — `createRpcHandlers(kb, llm)` (one factory, both handler families). `LlmOptions { model, apiKey, headers, budget, signal, completeFn? }`. `runAnalystCall`: budget pre-check (throws "budget exhausted ($spent of $max, n calls)"), `complete()` with the bare prompt as the only user message (no system prompt, no `reasoningEffort`, provider-default `maxTokens`), transport throws wrapped, `stopReason "error"` → throw with `errorMessage` (not charged), `"aborted"` → throw (not charged), charge then return `assistantText(msg)` on stop/length. `llm_query` registered at 5 min, `llm_query_batched` at 15 min; KB handlers stay plain functions on the 60 s default. Batched: array/≤100/non-empty-string validation, `[]` → `[]` without a model call, `mapWithConcurrencyLimit` (exported for tests) at cap 16, per-item failures contained as `"[llm_query error: ...]"` strings.
- `investigator.ts` — `InvestigationOptions.budget: BudgetTracker` replaces `maxBudgetUsd` (no back-compat, per repo rules). Top-of-loop check is `budget.exhausted()`; the budget stop message names both dimensions. Charge on `stop`/`length` only (previously every reply was charged, including `error`/`aborted`). `InvestigationResult.costUsd` reports `budget.spentUsd` (pool total; documented for Phase 5 tree semantics). `assistantText()` exported for `rpc.ts`.
- `prompt.ts` — Environment section documents `llm_query` (analyst sees ONLY the prompt string) and `llm_query_batched` (16-way, in-order, error strings); rules of thumb cover delegation instead of printing long docs, and stopping at "budget exhausted".
- `index.ts` — new params `analystProvider` / `analystModel` / `maxLlmCalls` (validated positive integer). Analyst resolved fail-fast through `ctx.modelRegistry.find()` + `getApiKeyAndHeaders()`, symmetric with the investigator (defaults `azure-foundry/gpt-5.4-nano` per the locked decision; the PLAN.md body's `gpt-5.4-mini` mention lost). `BudgetTracker(maxBudgetUsd, maxLlmCalls + maxTurns)` — one shared call cap sized with headroom for the investigator's own turns. `details` gains `modelCalls: budget.callCount`.
- `test-phase4.ts` (new) — 18 tests: 2 unit (tracker, concurrency helper incl. rejection propagation), 5 host-level (markers, round trips, validation tracebacks, per-item failure), 6 handler-level (charging, exhaustion pre-check with zero completeFn invocations, 40-prompt concurrency high-water ≤ 16, batched budget cut-off, error-not-charged, length-charged), 2 timeout-integration (exec-timer suspension with a pure-Python control that still dies, 200 ms per-handler override + block keeps running after re-arm), 3 loop-level (shared pool tripping on mixed spend, `costUsd === budget.spentUsd` on budget/final/aborted paths, abort mid-batch with an unhandled-rejection counter).
- `test-phase3.ts` — mechanical `BudgetTracker` swap (`maxBudgetUsd: X` → `budget: new BudgetTracker(X, 1_000)`); phase-marker expectation bumped to 4. All 20 stay green. `test-phase2.ts` — marker expectation bumped to 4; all 13 stay green (plain-function handler regression covered implicitly).
- `test-phase2-agentkb.ts` — updated to the two-argument `createRpcHandlers` with a stub analyst (`completeFn` that throws if ever reached); still gated behind `RLM_AGENTKB_TESTS=1` and skips cleanly without it.

## Post-implementation review fixes

Five improvements applied after a code review of the completed phase:

1. **`mapWithConcurrencyLimit` — `limit = 0` guard** (`rpc.ts`): `Math.max(1, limit)` added inside
   the `Math.min(…, items.length)` expression. Previously, a `limit` of 0 would produce 0 workers
   and return a sparse `undefined`-filled array instead of running items sequentially. The fix
   clamps to at least 1 worker; the empty-items case (`items.length === 0`) is still handled
   correctly because `Math.min(1, 0) = 0`. Added a JSDoc precondition note and an inline comment.

2. **`llm_query_batched` — empty-array early return moved before the element-validation loop**
   (`rpc.ts`): the `if (prompts.length === 0) return []` check previously appeared after the
   `for (const p of prompts)` validation loop. The loop is a no-op on an empty array so the
   behaviour was correct, but the natural read order is: bail early, then validate, then fan out.

3. **`ready()` — consistent rejection form** (`repl.ts`): the "already waiting for ready" path used
   `new Promise((_, reject) => reject(…))` while every other rejection path in the same method used
   `Promise.reject(…)`. Changed to `Promise.reject(…)` for consistency.

4. **`host.py` — protocol I/O capture comment**: added a three-line comment above `_PROTOCOL_OUT`
   and `_PROTOCOL_IN` explaining that they are captured before any `exec()` block redirects
   `sys.stdout`, so protocol traffic and user `print()` output are always separated.

5. **`investigator.ts` — unreachable retry message comment**: when `stopReason === "length"` is
   charged and the budget is now exhausted, the retry user message pushed below the charge is never
   read by any model call (the next iteration exits on `budget.exhausted()` before `complete()`).
   Added a comment noting this so Phase 5 authors aren't confused when the dead-weight message
   appears in serialised histories passed to nested investigators.

## Notes / deviations

- Test 16's PHASE4.md sketch implied the refused analyst call is visible to the fake model; it is not — `runAnalystCall` pre-checks the budget and throws before invoking `completeFn`, so the refused prompt never appears in the analyst call log. The test asserts that (and the in-REPL `RuntimeError` the investigator sees instead).
- Batched budget cut-off is not "first ~3 items": all 16 concurrency-window siblings pass the pre-check before any completion charges the pool (workers reach their first `await` before any timer fires), so the answered head is roughly the concurrency window plus a few second-wave items. The test asserts the robust invariants instead: head answered, tail are budget-error strings, answered count == `callCount`, spend ≥ `maxUsd`.
- A handler that loses the timeout race but later resolves is dropped by `Promise.race` — `writeRpcResponse` runs exactly once per RPC, so no stale `rpc_response` can desynchronize the host's stdin (verified by the per-handler-timeout test, where the block keeps executing afterwards).

## Test environment

All suites pass on the private machine with `RLM_PYTHON=C:\Users\User\miniconda3\python.exe` (no agentkb, no API keys): 18/18 Phase 4, 20/20 Phase 3, 13/13 Phase 2.

```
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase4.ts
```

## Verification status

- Type-check clean via a temporary tsconfig extending the root config (`target`/`lib` es2024, includes `.pi/extensions/rlm` plus the `highlight.js` ambient d.ts). Config removed after the run.
- Biome clean via a temporary config in `%TEMP%` (repo `biome.json` is a root config and excludes `.pi/`). Config removed after the run.

## Still open (corporate machine)

- Pi end-to-end: a question that plausibly needs delegation (e.g. "Summarize what the wiki says about X across all related pages"). Verify: `llm_query`/`llm_query_batched` visible in the transcript, both models resolved (`Kimi-K2.6` + `gpt-5.4-nano`) and billed (`details.costUsd` above an investigator-only baseline, `details.modelCalls` > `details.turns`), Esc mid-batch aborts cleanly, no orphan Python process.
- Rerun `RLM_AGENTKB_TESTS=1` integration tests to confirm the updated `createRpcHandlers` wiring against real agentkb.
