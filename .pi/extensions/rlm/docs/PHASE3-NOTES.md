# Phase 3 Implementation Notes

Status of the Phase 3 implementation (investigator loop + final-answer builtins, per PHASE3.md).

## What was built

- `host.py` — `_RlmFinal(BaseException)` sentinel with `FINAL()` (non-string answers JSON-serialized, `str()` fallback), `FINAL_VAR()`, `SHOW_VARS()` (skips `_INITIAL_KEYS` + dunders, reprs capped at 200 chars), per-exec `_final_value` reset so a stale final never leaks, `set_var` protocol message (replies with a normal `result` envelope; invalid name -> `error`), `_RLM_HOST_PHASE = 3`, five-entry `_RLM_BUILTINS`.
- `repl.ts` — extracted the shared `sendRequest()` helper; `exec()` keeps its public signature, new `setVar(name, value)` sends `set_var` and rejects when the result carries `error`. No state-machine changes.
- `prompt.ts` (new) — `buildSystemPrompt()`; the question goes into the first user message, not the system prompt. Carries `contextNote` when the initial search failed. The `question` field from the PHASE3.md `PromptOptions` sketch was dropped since the prompt never embeds it.
- `investigator.ts` (new) — `runInvestigation()` with injectable `completeFn` (exported as `CompleteFn`), last-fenced-block extraction (empty/unterminated = no code), head 70 % + tail 20 % output capping with omission marker, stdout/stderr/error observation message, simple per-run budget cap, best-effort answer on `max_turns`/`budget` without an extra model call, abort checks at turn start and around `complete()`/`exec()`. `systemPrompt` was added to `InvestigationOptions` (built by `index.ts`, which knows the context counts); the PHASE3.md interface sketch omitted it.
- `index.ts` — rewritten as the real `rlm_query` tool (`prompt` param; the Phase 2 raw-`code` debug tool is gone). Resolves the investigator model through `ctx.modelRegistry.find()` (default `azure-foundry/Kimi-K2.6`, no `reasoningEffort`), surfaces missing-model and auth errors by throwing, runs the initial `kbSearch()` from TypeScript with graceful degradation to `context = []` + `contextNote`, preloads `context` via `setVar`, streams a capped transcript through `onUpdate`, closes the REPL in `finally`.
- `test-phase3.ts` — 18 tests: 8 host-level (markers, FINAL semantics incl. `except Exception:` survival and stale-final reset, FINAL_VAR, SHOW_VARS, setVar round trip incl. non-ASCII and invalid-name rejection) and 10 loop-level with a real REPL + scripted fake `completeFn` (happy path, no-code, error recovery with traceback in the next observation, max_turns, budget, output capping, last-block-wins, in-band model error, abort between turns, event ordering).

## Review fixes (post-implementation)

- `investigator.ts` — `stopReason: "length"` is now handled: a token-limit-truncated reply is never executed (even a complete-looking fence may be missing its tail); the loop appends a "your reply was cut off — resend the complete block" user message and continues, so the truncated prose can no longer end the run as a silent `no_code` answer.
- `investigator.ts` — `FENCE_RE` accepts `\r?\n` after the opening fence so CRLF replies don't degrade to `no_code`.
- `investigator.ts` — the `done` event now fires on every exit path (`max_turns`, `budget`, `error`, `aborted` included), via a `finish()` wrapper; previously only `final` and `no_code` emitted it. `InvestigationResult.turns` documents the counting convention: turns = model calls made/attempted; a turn that exits at the top-of-loop budget/abort check does not count.
- `index.ts` — caller errors now fail fast: `k` (integer 1..50), `maxTurns` (positive integer), and `maxBudget` (positive) are validated before anything runs; only environmental failures degrade to the empty-context path.
- `index.ts` — the live transcript no longer duplicates code blocks (the `assistant_text` event already contains the fenced code; the `code_block` entry was dropped), uses tail-weighted capping (`capTranscript`) so the newest activity stays visible instead of being squeezed into `capText`'s 20 % tail, and is seeded with a visible note when the initial `kb_search` failed.
- `index.ts` — the REPL `pythonPath` default falls back to `process.env.RLM_PYTHON` before the corporate venv path, matching the test scripts, so private-machine runs need no `pythonPath` param.
- `prompt.ts` — the prompt now tells the model hit dicts only guarantee `path` (use `.get()` for other keys; `setVar`'s `JSON.stringify` drops `undefined` fields, so missing keys raise `KeyError` otherwise), and a code comment documents that "No network access, no pip" is a behavioral nudge only — the host is not sandboxed.
- `test-phase3.ts` — two new tests (20 total): `extractLastCodeBlock` edge cases (unterminated fence, whitespace-only block, CRLF, last-block-wins) and the length-truncation retry path (nudge message visible to the next call, truncated code never executed); the max-turns test additionally asserts the `done` event fires on that exit.

Deliberately unchanged: the budget check still only runs before a model call (a single call can overshoot `maxBudget`, per PHASE3.md), and `capText`'s head-weighted split stays for observation messages where it is the right bias.

## Test environment

All 20 tests pass on the private machine with `RLM_PYTHON=C:\Users\User\miniconda3\python.exe` (no agentkb needed; loop tests use mock RPC handlers). The script imports `@earendil-works/pi-ai`, so it must run through tsx with the root tsconfig path mapping, not plain node:

```
RLM_PYTHON=<python> node_modules/.bin/tsx --tsconfig tsconfig.json .pi/extensions/rlm/test-phase3.ts
```

## Verification status

- Type-check clean via a temporary tsconfig extending the root config (`target`/`lib` es2024, includes `.pi/extensions/rlm` plus the `highlight.js` ambient d.ts). Config removed after the run.
- Biome clean via a temporary config outside the repo (the repo `biome.json` is a root config and rejects a second root; `--config-path` to a copy in `%TEMP%` works). Config removed after the run.

## Still open (corporate machine)

- Pi end-to-end: ask `rlm_query` a real wiki question; verify preloaded context, multi-turn loop with `kb_search`/`kb_read` visible in onUpdate output, `FINAL` answer, `details.costUsd > 0`, no orphan Python process, Esc aborts cleanly mid-run.
- Private-machine Pi end-to-end (optional): expects the `context = []` + contextNote path; override `investigatorProvider`/`investigatorModel` to a resolvable model.
