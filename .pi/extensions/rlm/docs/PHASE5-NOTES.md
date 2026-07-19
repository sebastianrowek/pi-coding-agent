# Phase 5 Implementation Notes

Status of the Phase 5 implementation (rlm_query recursion + shared budget across the tree + depth limiting, per PHASE5.md).

## What was built

- `host.py` — `rlm_query` / `rlm_query_batched` shims (same `_rpc_call` shape as the Phase 4 pair; argument validation lives in the TS handlers), `_RLM_HOST_PHASE = 5`, nine-entry `_RLM_BUILTINS`. A non-JSON-serializable `context` argument (e.g. a `set`) makes `json.dumps` inside `_send_protocol` raise before anything is written, so the protocol stream stays intact — verified by test 5, no code change needed.
- `rpc.ts` — `createRpcHandlers(kb, llm, rlm)` with a third **required** `RlmRecursionOptions` argument (no back-compat; both existing call sites updated). `RlmRecursionOptions { depth, maxDepth, replPythonPath, maxTurns, outputCapChars, k, scope, kbSearchFn?, completeFn?, stats?, onNested? }`. `runNestedRlmQuery()`: budget pre-check (before the depth check, so an exhausted pool never spawns anything) → silent downgrade to `runAnalystCall(composeDowngradePrompt(...))` at `depth >= maxDepth` (passed context folded in as JSON, capped 8 000 chars) → child context (parent list verbatim, else `kbSearchFn`/`kbSearch` with graceful degradation to empty context + prompt note) → stats/onNested → child `PythonRepl` wired via the recursive `createRpcHandlers(kb, llm, { ...rlm, depth: childDepth })` call → `runInvestigation` driven by the **analyst** model → result mapping (`final`/`no_code`/`max_turns`/`budget` return the answer string; `error` throws "nested investigation failed"; `aborted` throws) → `finally` closes the child REPL on every path. Handlers registered at 20 min (`rlm_query`) / 60 min (`rlm_query_batched`); batch validation (`<= 20` prompts, contexts length must match, each context a list or None); fan-out via `mapWithConcurrencyLimit` at cap 4 with per-item `"[rlm_query error: ...]"` containment. The runner lives in `rpc.ts` because it and `createRpcHandlers` are mutually recursive.
- `prompt.ts` — `PromptOptions` gains `contextFromParent?` (switches the `context` description to "provided by the parent investigation") and required `canRecurse` (when false, the `rlm_query` doc line says it downgrades and to prefer `llm_query`). Environment section documents both builtins (shared-budget warning, error-string contract); rules of thumb cover rlm vs llm delegation and nested-run cost.
- `index.ts` — new `maxDepth` param (default 2, integer >= 0; 0 = recursion kill switch). `replPythonPath` hoisted into a local shared by the top-level REPL and the recursion options; `scope` likewise. `stats = { nestedRuns: 0 }`; `onNested` pushes one transcript line per lifecycle event (`[depth N rlm_query started: <120-char prompt head>]` / `[... finished: <stopReason>, <turns> turns]`) through a shared `pushUpdate()` (tracks `lastTurn` for `details.turns`). Top-level prompt gets `canRecurse: maxDepth > 0`. `details` gains `nestedRuns`; `maxLlmCalls` description now names nested-investigation turns. Budget construction unchanged — child turns charge the same pool and consume the same `maxLlmCalls + maxTurns` cap by design.
- `repl.ts`, `investigator.ts`, `budget.ts`, `agentkb.ts` — no changes, as planned: nested runs ride entirely on the Phase 4 per-handler timeouts and exec-timeout suspension, and each child has its own pipes so parent/child protocol traffic cannot interleave.
- `test-phase5.ts` (new) — 17 tests: 5 host-level (marker/nine builtins, mock round trip with context passthrough, validation tracebacks, batched order + `[]` + contexts mismatch, non-serializable context leaves the protocol intact), 9 runner-level (happy path + child REPL cleanup, parent-provided context with "provided by the parent investigation" prompt + zero searches, fresh child search with configured k/scope, search-failure degradation, depth downgrade with folded context, `maxDepth: 0` kill switch, budget pre-check with zero fake invocations, shared pool tripped by child spend with the stop-note string visible to the parent, child error → parent `RuntimeError`), batched (6 prompts, high-water <= 4 and > 1, in-order, per-item failure contained), abort mid-nested-run (in-band aborted reply, run ends `aborted`, onNested end fired with `aborted`, no unhandled rejections), and 1 loop-level end-to-end two-level recursion (`costUsd === budget.spentUsd` covers both levels).
- `test-phase4.ts` / `test-phase2-agentkb.ts` — updated to the three-argument `createRpcHandlers` with a minimal `RlmRecursionOptions` (`depth: 0, maxDepth: 0`, child `completeFn` that throws if ever reached). Phase-marker expectations bumped to 5 (and nine builtins where counted) in `test-phase2.ts` / `test-phase3.ts` / `test-phase4.ts`; `buildSystemPrompt` call sites gained `canRecurse`.

## Notes / deviations

- PHASE5.md test 17 said "`done` events fire at both levels". `runNestedRlmQuery` deliberately does not wire `onEvent` into child runs (Phase 6 owns rendering), so the child's `done` event is not observable. The test asserts the `onNested` start/end pair (which carries the child's `stopReason` and `turns`) plus the parent's `done` event instead.
- The transcript prompt preview in `index.ts` is a plain 120-char head slice, not `capText` — head+tail capping would inject newlines into what should be a single transcript line.
- `stats.nestedRuns` increments before the child spawn, so children that later fail (`error`, abort) still count; the batched test asserts 6 nested runs including the scripted-to-fail item. Downgrades never count.
- In `rlm_query_batched`, the `[]` early return precedes contexts validation (same read order as the Phase 4 batched handler), so an empty prompts list with a non-empty `contexts` returns `[]` without an error.
- Test 16 (abort) uses the `onNested` end event (`stopReason: "aborted"`) as the observable proof that the runner's `finally` path completed for the child; the child REPL itself is not reachable from the test.

## Test environment

All suites pass on the private machine with `RLM_PYTHON=C:\Users\User\miniconda3\python.exe` (no agentkb, no API keys): 17/17 Phase 5, 18/18 Phase 4, 20/20 Phase 3, 13/13 Phase 2.

```
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase5.ts
```

## Verification status

- Type-check clean via a temporary tsconfig at the repo root extending `./tsconfig.json` (`target`/`lib` es2024, includes `.pi/extensions/rlm` plus the `highlight.js` ambient d.ts). Config removed after the run. (Placing the temp config in `%TEMP%` does not work — `types: ["node"]` resolves relative to the config location.)
- Biome clean via a temporary config in `%TEMP%` (repo `biome.json` excludes `.pi/`); two files were auto-formatted (import order, call-argument wrapping).
- `npm run check`: only the known pre-existing failure (stale `kimi-k2.6:free` model id in `packages/ai/test/openai-completions-tool-choice.test.ts`); pinned-deps, ts-imports, and shrinkwrap checks pass. No new regressions.

## Still open (corporate machine)

- Pi end-to-end: a question that decomposes into independent sub-questions (e.g. `rlm_query("Compare what the wiki says about X and Y; cover setup, limitations, and ownership for each")`). Verify: `rlm_query`/`rlm_query_batched` visible in the transcript with depth markers, child runs use `gpt-5.4-nano`, `details.nestedRuns >= 1`, `details.costUsd` covers the tree, Esc mid-tree kills every Python process (check Task Manager), depth-2 `rlm_query` downgrades silently.
- Rerun `RLM_AGENTKB_TESTS=1` integration tests to confirm the three-argument `createRpcHandlers` wiring against real agentkb.
