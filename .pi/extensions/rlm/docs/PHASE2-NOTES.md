# Phase 2 Implementation Notes

Status of the Phase 2 implementation (RPC channel + `kb_search`/`kb_read` builtins, per PHASE2.md), including review fixes.

## What was built

- `host.py` — strict `_rpc_call()` (ID matching, malformed-JSON and `ok:false` handling as clean `RuntimeError`s), `kb_search`/`kb_read` shims, captured `_PROTOCOL_IN`/`_PROTOCOL_OUT` so user code can't corrupt the protocol, disabled `input()`, main-thread-only RPC guard, and the `_RLM_HOST_PHASE = 2` / `_RLM_BUILTINS` markers.
- `repl.ts` — `RpcHandler`/`RpcHandlers` types with `setRpcHandlers()`, handles `type:"rpc"` while `pendingExec` stays active (no new state), strict RPC shape validation (malformed = fatal, unknown method = Python-visible `ok:false`), per-RPC timeout (`rpcTimeoutMs`, default 60 s), and a write-after-close guard for late async handlers.
- `agentkb.ts` (new) — invokes the venv Python via argv array (`-m agentkb search --json -k … -s … -- <query>`, never a shell string), validates `k` in 1..50, strict-then-extracted JSON parsing with 4 000-char capped diagnostics, hit normalization that skips malformed entries, and `kbRead()` restricted to a configurable root (default: agentkb cwd, case-insensitive on Windows).
- `rpc.ts` (new) — `createRpcHandlers()` bridging the REPL to agentkb with strict argument validation, so `repl.ts` stays agentkb-agnostic.
- `index.ts` — debug tool wires in the KB builtins and exposes `agentkbPythonPath`/`agentkbCwd`/`restrictReadRoot` params; description states it's not the final investigator loop.
- `test-phase2.ts` — mock-handler protocol tests (stdout ordering, handler errors → tracebacks, unknown method, RPC timeout, concurrent-exec guard during RPC, thread guard, `input()` disabled). `test-phase2-agentkb.ts` — 7 real integration tests, gated behind `RLM_AGENTKB_TESTS=1`; they skip cleanly without that flag.

## Review fixes (post-implementation)

- `repl.ts` — `ready()` called during a running exec now resolves immediately. Previously it armed a startup-timeout deferred that no `ready` message would ever resolve, so it killed the running exec after `startupTimeoutMs`.
- `repl.ts` — `kill()` no longer relies on `proc.killed` (which only means the signal was *sent*); it checks `exitCode`/`signalCode` and escalates SIGTERM → SIGKILL via an unref'd 1 s timer cancelled on process close. Moot on Windows, matters on POSIX.
- `agentkb.ts` — `--` separator before the query so model-generated queries starting with `-` aren't parsed as CLI options. Assumes an argparse-style CLI; confirm during the corporate-machine integration run.
- `agentkb.ts` — `kbRead` root check handles drive roots (`restrictReadRoot: "C:\\"` previously rejected every path because of double-separator prefixing).
- Documented accepted limitations as code comments: the `input()` shadow covers only the global name (`builtins.input` / `sys.stdin.read()` can still consume protocol stdin — not preventable in-process), and the `kbRead` containment check is lexical (no realpath), so a junction inside the root could escape it.
- Added test 13 ("ready() During Exec") to `test-phase2.ts` as a regression test.
- Fixed biome style findings in `repl.ts`/`test-phase1.ts` (template literals, optional chains, import order).

Known quirk (no fix needed yet): `close()` while Python is blocked inside `_rpc_call` makes the shutdown message be consumed as a malformed RPC response; shutdown then relies on the 2 s kill timer. Unreachable through the current debug tool (`close()` runs after `exec` settles); revisit when the Phase 3 investigator loop adds cancellation.

## Test environment adaptation

agentkb is not installed on the private machine, so the phase 1 + 2 test scripts honor an `RLM_PYTHON` env override, falling back to the corporate venv path. Both suites pass with miniconda Python 3.12.7: 21/21 Phase 1, 13/13 Phase 2.

## Verification status

- Type-check clean via a temporary tsconfig extending the root config (`.pi/extensions` is not covered by the root include) plus the `highlight.js` ambient d.ts; `target: es2024`.
- Biome clean via a temporary config (the repo `biome.json` excludes `.pi/`).
- `npm run check` as a whole fails only on pre-existing issues unrelated to this work: unpinned deps in the bash-guard/web-fetch extensions and stale model ids in five `packages/ai` tests.

## Still open (corporate machine)

- Real agentkb integration tests: `RLM_AGENTKB_TESTS=1` + `node .pi/extensions/rlm/test-phase2-agentkb.ts`. Also confirms the `--` separator is accepted by the agentkb CLI.
- Manual single-turn debug test (`kb_search` → `kb_read` through the Pi tool).
