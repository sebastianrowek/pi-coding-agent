# Phase 1: Python REPL Host + TypeScript Driver

## Goal

Create the subprocess plumbing that lets the TypeScript extension send Python code blocks to a persistent Python REPL and receive captured `stdout`, `stderr`, and exception information.

This phase deliberately excludes RPC builtins, `agentkb`, LLM calls, investigator loops, recursion, budget tracking, custom rendering, and logging. The only goal is to prove that the local extension can safely spawn and drive a persistent Python process over an NDJSON protocol.

---

## Scope

Phase 1 implements:

1. A Python REPL host process.
2. A TypeScript driver class that manages the Python subprocess.
3. A minimal Pi extension entry point for manual end-to-end testing.
4. An ad-hoc test script covering the subprocess protocol and lifecycle behavior.

Phase 1 does **not** implement:

- `kb_search`
- `kb_read`
- `llm_query`
- `rlm_query`
- `FINAL`
- `FINAL_VAR`
- `SHOW_VARS`
- Batched calls
- Budget tracking
- Model calls via `complete()`
- Investigator loop / system prompt
- Recursion / depth limits
- NDJSON event logging
- Custom `renderCall` / `renderResult`
- Jupyter export

---

## Files to Create

```text
.pi/extensions/rlm/
  host.py       Python REPL host process
  repl.ts       TypeScript subprocess driver
  index.ts      Minimal temporary Pi tool registration for Phase 1 testing
  PHASE1.md     This plan
```

---

## Protocol Overview

Phase 1 uses newline-delimited JSON over stdin/stdout.

The Python process writes only protocol messages to stdout. User Python code output is captured using `io.StringIO` and embedded inside result messages.

---

## Host to Extension Messages

### Ready

Emitted once after the host boots successfully.

```json
{ "type": "ready" }
```

### Exec Result

Returned after an `exec` request completes.

```json
{
  "type": "result",
  "id": 1,
  "stdout": "hello\n",
  "stderr": "",
  "error": null,
  "final": null
}
```

Fields:

- `type`: Always `"result"`.
- `id`: The request ID from the matching `exec` message.
- `stdout`: Captured user-code stdout.
- `stderr`: Captured user-code stderr.
- `error`: Full traceback string if execution raised; otherwise `null`.
- `final`: Always `null` in Phase 1. Reserved for later phases.

---

## Extension to Host Messages

### Execute Code

```json
{
  "type": "exec",
  "id": 1,
  "code": "print('hello')"
}
```

### Shutdown

```json
{ "type": "shutdown" }
```

The shutdown message asks the host to exit gracefully. If the host does not exit within a short timeout, the TypeScript driver force-kills the process.

---

## Key Phase 1 Decisions

### 1. NDJSON over stdin/stdout

The host and driver communicate using newline-delimited JSON over standard pipes.

Rationale:

- Works cross-platform, including Windows.
- Avoids TCP setup and firewall/security complications.
- Matches the final architecture where the Python process is a local child process.
- Makes the process boundary easy to test.

---

### 2. Protocol stdout is separate from user stdout

The Python host must preserve the original stdout object:

```python
_PROTOCOL_OUT = sys.stdout
```

All protocol writes must use `_PROTOCOL_OUT` directly, not `print()` against the current `sys.stdout`.

This matters because user code is executed while `sys.stdout` is redirected. Later phases will need RPC builtins that emit protocol messages while user stdout is captured. If protocol writes accidentally use redirected stdout, RPC messages will be swallowed into user output and the protocol will deadlock.

---

### 3. Captured user stdout/stderr

During each `exec`, the host redirects:

```python
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
```

After execution, the original streams are restored and the captured values are returned in the result envelope.

This guarantees that user code such as:

```python
print('{"type":"ready"}')
```

does not corrupt the protocol.

---

### 4. Request IDs from the beginning

Even though Phase 1 supports only one in-flight `exec`, every `exec` and `result` message includes an `id`.

Rationale:

- Makes debugging easier.
- Prepares the protocol for Phase 2 RPC messages.
- Allows stale or unexpected results to be detected cleanly.
- Avoids a protocol shape change later.

---

### 5. Single in-flight exec

The driver allows only one pending `exec()` at a time.

If `exec()` is called while another execution is pending, the second call must reject immediately with a clear error.

This matches the final investigator loop, where each turn sends one code block and waits for completion before continuing.

---

### 6. Persistent namespace

The Python host maintains a namespace dictionary for the lifetime of the process.

Variables, imports, and function definitions survive across `exec()` calls.

The namespace should be initialized deliberately:

```python
namespace = {
    "__name__": "__rlm_repl__",
    "__builtins__": __builtins__,
}
```

This makes Python code behave more predictably than with a completely empty dictionary.

---

### 7. Full exception capture

The host should catch `BaseException`, not just `Exception`.

Rationale:

- `SystemExit` should not terminate the host.
- `KeyboardInterrupt` should be returned as an execution error.
- User code should not be able to accidentally kill the REPL process via normal Python exceptions.

The full traceback should be returned in the `error` field.

---

### 8. UTF-8 and unbuffered I/O

The TypeScript driver should spawn Python with `-u`:

```text
python -u host.py
```

The host should also attempt to configure stdio as UTF-8:

```python
try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass
```

The Node side should write JSON using UTF-8.

Rationale:

- Avoids Windows code-page surprises.
- Supports non-ASCII output, paths, and KB content.
- Reduces buffering-related handshake issues.

---

### 9. Timeouts

The driver should support:

- Startup timeout
- Exec timeout
- Graceful shutdown timeout

Recommended defaults:

```typescript
startupTimeoutMs: 10_000
execTimeoutMs: 120_000
shutdownTimeoutMs: 2_000
```

If an `exec()` times out, the driver should kill the Python process and reject the pending call.

In Phase 1, killing the process is acceptable because arbitrary Python code running on the main thread cannot be safely interrupted from the outside.

---

### 10. Lifecycle states

The TypeScript driver should explicitly track lifecycle state.

Suggested states:

```typescript
type ReplState =
  | "starting"
  | "ready"
  | "executing"
  | "closed"
  | "failed";
```

Expected behavior:

- `ready()` after close rejects.
- `exec()` after close rejects.
- `exec()` after process failure rejects.
- `close()` is idempotent.
- Process crash while waiting for `ready()` rejects `ready()`.
- Process crash while waiting for `exec()` rejects the pending `exec()`.

---

## File 1: `host.py`

### Responsibilities

The Python host must:

1. Configure UTF-8 stdio where possible.
2. Preserve the original stdout for protocol messages.
3. Initialize a persistent namespace.
4. Emit a `ready` message after boot.
5. Read NDJSON messages from stdin.
6. Execute `exec` messages in the persistent namespace.
7. Capture user stdout/stderr.
8. Return a single result message per exec.
9. Return tracebacks in `error`.
10. Support graceful `shutdown`.
11. Never write raw user output to stdout.

### Draft Implementation Shape

```python
import sys
import json
import io
import traceback

_PROTOCOL_OUT = sys.stdout

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

namespace = {
    "__name__": "__rlm_repl__",
    "__builtins__": __builtins__,
}

def send(msg):
    _PROTOCOL_OUT.write(json.dumps(msg, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()

send({"type": "ready"})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        send({
            "type": "result",
            "id": None,
            "stdout": "",
            "stderr": "",
            "error": f"Invalid JSON: {line[:200]}",
            "final": None,
        })
        continue

    msg_type = req.get("type")
    req_id = req.get("id")

    if msg_type == "shutdown":
        break

    if msg_type != "exec":
        send({
            "type": "result",
            "id": req_id,
            "stdout": "",
            "stderr": "",
            "error": f"Unknown type: {msg_type}",
            "final": None,
        })
        continue

    old_out, old_err = sys.stdout, sys.stderr
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    sys.stdout = out_buf
    sys.stderr = err_buf

    exc = None
    try:
        exec(req.get("code", ""), namespace)
    except BaseException:
        exc = traceback.format_exc()
    finally:
        sys.stdout = old_out
        sys.stderr = old_err

    send({
        "type": "result",
        "id": req_id,
        "stdout": out_buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "error": exc,
        "final": None,
    })
```

### Important Notes

- Use `_PROTOCOL_OUT.write(...)`, not `print(...)`, for protocol messages.
- Use `ensure_ascii=False` to preserve readable Unicode.
- Restore stdout/stderr in a `finally` block.
- Catch `BaseException` so `SystemExit` and `KeyboardInterrupt` do not kill the host.
- `final` is always `null` in Phase 1.

---

## File 2: `repl.ts`

### Responsibilities

The TypeScript driver must:

1. Spawn the Python host via `node:child_process.spawn`.
2. Use the configured Python binary path.
3. Pass `-u` to Python.
4. Resolve the host path.
5. Read stdout line-by-line.
6. Parse host messages as JSON.
7. Wait for the `ready` handshake.
8. Provide `exec(code: string): Promise<ExecResult>`.
9. Enforce one in-flight exec at a time.
10. Match results by request ID.
11. Implement startup, exec, and shutdown timeouts.
12. Capture child-process stderr for diagnostics.
13. Kill the host on timeout, crash, parse failure, or abort.
14. Make `close()` idempotent.

### Suggested Interface

```typescript
export interface ExecResult {
  stdout: string;
  stderr: string;
  error?: string | null;
  final?: string | null;
}

export interface PythonReplOptions {
  pythonPath: string;
  hostPath?: string;
  cwd?: string;
  startupTimeoutMs?: number;
  execTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
}

export class PythonRepl {
  constructor(options: PythonReplOptions);

  ready(): Promise<void>;

  exec(code: string): Promise<ExecResult>;

  close(): Promise<void>;
}
```

### Message Types

```typescript
type HostMessage =
  | { type: "ready" }
  | {
      type: "result";
      id: number | null;
      stdout: string;
      stderr: string;
      error?: string | null;
      final?: string | null;
    };

type ExecMessage = {
  type: "exec";
  id: number;
  code: string;
};

type ShutdownMessage = {
  type: "shutdown";
};
```

### Spawn Behavior

Spawn using:

```typescript
spawn(pythonPath, ["-u", hostPath], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
});
```

The default Python path should point to the local `agentkb` venv used by later phases:

```text
C:\Appl\workspace\Python\agentkb\venv\Scripts\python.exe
```

This should be configurable.

### Stderr Diagnostics

Child-process stderr is not user-code stderr. User-code stderr is captured inside result envelopes.

The driver should collect child-process stderr into a capped diagnostic buffer.

Suggested cap:

```typescript
const MAX_DIAGNOSTIC_CHARS = 20_000;
```

Use this buffer when reporting:

- Startup failure
- Host crash
- JSON parse failure
- Exec interrupted by process exit

Example error message should include:

- Exit code
- Signal
- Recent process stderr
- Current REPL state
- Pending request ID, if any

### Ready Handling

The constructor may start the process immediately, but callers should await:

```typescript
await repl.ready();
```

If the host does not emit `ready` within `startupTimeoutMs`, reject and kill the process.

### Exec Handling

`exec(code)` should:

1. Ensure the REPL is ready.
2. Reject if closed or failed.
3. Reject if another exec is pending.
4. Allocate a new numeric request ID.
5. Send the JSON message plus newline.
6. Wait for a matching `result`.
7. Reject on timeout, process exit, parse failure, or abort.
8. Resolve with `{ stdout, stderr, error, final }`.

If a result arrives with an unexpected ID, treat it as a fatal protocol error and kill the process.

### Close Handling

`close()` should be idempotent.

Preferred flow:

1. If already closed, return.
2. If process is alive and stdin is writable, send `{ "type": "shutdown" }`.
3. Wait up to `shutdownTimeoutMs`.
4. If still alive, kill the process.
5. Resolve/reject any pending operations.

### Abort Handling

If `options.signal` is provided:

- Listen for `abort`.
- Kill the host process.
- Reject pending `ready()` or `exec()`.
- Remove the abort listener during cleanup.

This is needed later for Pi Esc/cancel handling.

---

## File 3: `index.ts`

### Purpose

`index.ts` is only temporary Phase 1 scaffolding.

It registers a minimal tool so the subprocess plumbing can be tested from inside Pi.

The final `rlm_query` implementation will replace this in Phase 3.

### Recommended Tool Shape

Tool name may remain:

```text
rlm_query
```

However, the description must make it clear that this is not the final RLM behavior.

Suggested description:

```text
Phase 1 debug tool: executes raw Python code in a temporary local Python REPL host.
This is not the final RLM investigator loop.
```

### Parameters

Prefer using `code` instead of `prompt` for Phase 1:

```typescript
{
  code: Type.String({
    description: "Raw Python code to execute in the Phase 1 REPL."
  })
}
```

If compatibility with the future final shape requires `prompt`, then document that `prompt` is interpreted as raw Python code in Phase 1.

Optional parameters:

```typescript
{
  code: string;
  timeoutMs?: number;
  pythonPath?: string;
}
```

### Execute Flow

The temporary tool should:

1. Create a `PythonRepl`.
2. Await `ready()`.
3. Execute the provided raw Python code once.
4. Return stdout, stderr, and error in the tool output.
5. Always close the REPL in a `finally` block.

### Output Format

Return a clear text response:

```text
STDOUT:
...

STDERR:
...

ERROR:
...
```

If `error` is null, show:

```text
ERROR:
<none>
```

### Important Phase 1 Behavior

`exec("2 + 2")` returns no stdout because Python `exec` does not display expression results.

Manual users should call:

```python
print(2 + 2)
```

Expected Pi output:

```text
STDOUT:
4

STDERR:

ERROR:
<none>
```

---

## File 4: `PHASE1.md`

This file records the Phase 1 implementation plan.

It should live at:

```text
.pi/extensions/rlm/PHASE1.md
```

---

## Testing Strategy

Use an ad-hoc in-repo or temporary TypeScript script.

Do not run the full test suite unless explicitly requested.

Example locations:

```text
.pi/extensions/rlm/test-phase1.ts
```

or:

```text
/tmp/test-rlm-phase1.ts
```

The tests should import `PythonRepl` from `repl.ts` and run the matrix below.

---

## Required Tests

### 1. Spawn and Ready

Method:

```text
Create PythonRepl and await ready()
```

Expected:

- `ready()` resolves.
- No timeout.
- Process remains alive.

---

### 2. Simple Exec

Code:

```python
print("hello")
```

Expected:

```text
stdout == "hello\n"
stderr == ""
error == null
```

---

### 3. Namespace Persistence

Turn 1:

```python
x = 42
```

Turn 2:

```python
print(x)
```

Expected for turn 2:

```text
stdout == "42\n"
error == null
```

---

### 4. Function Persistence

Turn 1:

```python
def add(a, b):
    return a + b
```

Turn 2:

```python
print(add(2, 3))
```

Expected:

```text
stdout == "5\n"
error == null
```

---

### 5. Import Persistence

Turn 1:

```python
import math
```

Turn 2:

```python
print(math.sqrt(16))
```

Expected:

```text
stdout == "4.0\n"
error == null
```

---

### 6. Exception Handling

Code:

```python
1 / 0
```

Expected:

```text
stdout == ""
stderr == ""
error contains "ZeroDivisionError"
host remains alive
```

---

### 7. Host Survives SystemExit

Code:

```python
raise SystemExit(3)
```

Expected:

```text
error contains "SystemExit"
host remains alive
```

Then run:

```python
print("still alive")
```

Expected:

```text
stdout == "still alive\n"
```

---

### 8. Stderr Capture

Code:

```python
import sys
sys.stderr.write("oops")
```

Expected:

```text
stdout == ""
stderr == "oops"
error == null
```

---

### 9. Large Stdout

Code:

```python
print("x" * 100000)
```

Expected:

- Full stdout is returned.
- No truncation.
- No JSON corruption.
- Error is null.

---

### 10. JSON-looking Stdout

Code:

```python
print('{"type":"ready"}')
print('{"type":"result","stdout":"fake"}')
```

Expected:

- Both lines appear in captured stdout.
- The TypeScript driver does not interpret them as protocol messages.
- Error is null.

---

### 11. Unicode Output

Code:

```python
print("äöü ß 😀")
```

Expected:

```text
stdout == "äöü ß 😀\n"
error == null
```

---

### 12. Multiline Code and Output

Code:

```python
for i in range(3):
    print(f"line {i}")
```

Expected:

```text
stdout == "line 0\nline 1\nline 2\n"
error == null
```

---

### 13. Expression Behavior

Code:

```python
2 + 2
```

Expected:

```text
stdout == ""
stderr == ""
error == null
```

This confirms and documents that Phase 1 uses `exec`, not an interactive Python display hook.

---

### 14. Request ID Matching

Method:

- Execute two sequential requests.
- Verify internally that each result ID matches its request ID.

Expected:

- No stale result.
- No mismatched result.
- Both executions resolve correctly.

---

### 15. Concurrent Exec Guard

Method:

- Start one long-running exec.
- Immediately call `exec()` again before the first completes.

Example first code:

```python
import time
time.sleep(1)
print("done")
```

Expected:

- First call eventually resolves.
- Second call rejects immediately with a clear "one exec at a time" error.

---

### 16. Exec Timeout

Code:

```python
while True:
    pass
```

Use a short test timeout such as 500 ms.

Expected:

- `exec()` rejects with timeout error.
- Python process is killed.
- Later `exec()` calls reject with a clear "closed" or "failed" error.

---

### 17. Graceful Close

Method:

- Create REPL.
- Await ready.
- Call `close()`.

Expected:

- Host exits.
- No orphaned process remains.
- No unhandled promise rejection.

---

### 18. Double Close

Method:

- Call `close()` twice.

Expected:

- Both calls complete without throwing.
- No unhandled promise rejection.

---

### 19. Exec After Close

Method:

- Create REPL.
- Await ready.
- Close REPL.
- Call `exec("print('nope')")`.

Expected:

- Rejects with clear error.
- Does not attempt to write to closed stdin.

---

### 20. Startup Failure Diagnostics

Method:

- Provide an invalid `hostPath` or invalid Python script.

Expected:

- `ready()` rejects.
- Error includes child-process exit details and recent stderr.

---

### 21. Invalid Python Path

Method:

- Provide a nonexistent `pythonPath`.

Expected:

- Construction or `ready()` fails clearly.
- Error names the failed binary path.

---

## Manual Pi Test

After implementing `host.py`, `repl.ts`, and the temporary `index.ts`, load the extension in Pi and call:

```python
print(2 + 2)
```

Expected tool output:

```text
STDOUT:
4

STDERR:

ERROR:
<none>
```

Also test:

```python
x = 10
print(x * 3)
```

Expected:

```text
STDOUT:
30

STDERR:

ERROR:
<none>
```

Note: In the temporary Phase 1 tool, each tool call may create a new REPL process. Persistence is guaranteed within a single `PythonRepl` instance, and is tested by the ad-hoc test script. Cross-tool-call persistence is not required for Phase 1.

---

## Build Order

### Step 1: Create `host.py`

Implement:

- UTF-8 stdio setup.
- `_PROTOCOL_OUT`.
- `send()`.
- Persistent namespace.
- `ready` message.
- Main stdin loop.
- `exec` handling.
- stdout/stderr capture.
- exception capture.
- `shutdown` handling.

Run manually from a shell if useful:

```text
C:\Appl\workspace\Python\agentkb\venv\Scripts\python.exe -u .pi\extensions\rlm\host.py
```

Then paste:

```json
{"type":"exec","id":1,"code":"print('hello')"}
```

Expected response:

```json
{"type":"result","id":1,"stdout":"hello\n","stderr":"","error":null,"final":null}
```

---

### Step 2: Create `repl.ts`

Implement:

- `PythonReplOptions`.
- `ExecResult`.
- `PythonRepl`.
- process spawn with `-u`.
- stdout line reader.
- JSON message parser.
- ready promise.
- exec request/response.
- request ID allocation.
- pending request guard.
- timeout handling.
- child stderr diagnostic capture.
- graceful and forceful close.
- abort signal handling.

---

### Step 3: Create Ad-hoc Test Script

Write a temporary test script that imports `PythonRepl` and runs the required tests.

Keep it lightweight.

Do not run the full repository test suite unless requested.

---

### Step 4: Iterate Until Tests Pass

Fix:

- protocol parse issues
- lifecycle bugs
- Windows path issues
- timeout behavior
- process cleanup issues
- Unicode encoding issues

Do not proceed to `index.ts` until the ad-hoc test script passes.

---

### Step 5: Create Minimal `index.ts`

Register a temporary `rlm_query` tool.

For Phase 1, it should execute raw Python code, not perform natural-language investigation.

Use the local venv Python path by default:

```text
C:\Appl\workspace\Python\agentkb\venv\Scripts\python.exe
```

Expose `pythonPath` as an optional override if convenient.

Always close the REPL in `finally`.

---

### Step 6: Manual Interactive Pi Test

Load the extension and call the temporary tool with:

```python
print(2 + 2)
```

Verify the output shows `4`.

Also test error behavior:

```python
1 / 0
```

Expected:

- `ERROR` contains `ZeroDivisionError`.
- The tool returns cleanly.
- No raw traceback corrupts the Pi UI.

---

### Step 7: Run Type Check

Run:

```text
npm run check
```

Fix any extension type errors.

Do not run the full vitest suite unless explicitly requested.

---

## Implementation Notes for Future Phases

Phase 2 introduces RPC builtins such as `kb_search` and `kb_read`.

Because Phase 1 already preserves `_PROTOCOL_OUT`, Phase 2 can safely send RPC messages from inside Python builtin shims even while user stdout is redirected.

Future RPC message shape:

```json
{
  "type": "rpc",
  "id": 17,
  "method": "kb_search",
  "args": {
    "query": "...",
    "k": 5,
    "scope": "wiki"
  }
}
```

The host-side RPC helper must use the same protocol send path:

```python
_PROTOCOL_OUT.write(json.dumps(msg, ensure_ascii=False) + "\n")
_PROTOCOL_OUT.flush()
```

Do not use plain `print()` for protocol messages.

---

## Phase Completion Criteria

Phase 1 is complete when:

1. `host.py` emits `ready` and executes code blocks.
2. `repl.ts` can spawn the host, await readiness, send code, and receive results.
3. Namespace persistence works across multiple `exec()` calls in one `PythonRepl` instance.
4. stdout and stderr are captured correctly.
5. exceptions are returned as tracebacks without killing the host.
6. JSON-looking user output does not corrupt the protocol.
7. Unicode output works.
8. large stdout works.
9. exec timeout kills the process and rejects cleanly.
10. graceful close and double close work.
11. process crash diagnostics include useful stderr and exit information.
12. the temporary Pi tool can execute `print(2 + 2)` and show `4`.
13. `npm run check` passes.

---

## Locked Phase 1 Defaults

```text
Python path:
C:\Appl\workspace\Python\agentkb\venv\Scripts\python.exe

Protocol:
NDJSON over stdin/stdout

Python spawn args:
-u host.py

Startup timeout:
10_000 ms

Exec timeout:
120_000 ms

Shutdown timeout:
2_000 ms

Max diagnostic stderr buffer:
20_000 chars

Concurrency:
one exec in flight

Namespace:
persistent dict for host lifetime

RPC:
excluded from Phase 1

LLM calls:
excluded from Phase 1
```