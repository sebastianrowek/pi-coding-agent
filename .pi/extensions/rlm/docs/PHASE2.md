# RLM Extension — Phase 2 Implementation Plan

## Phase 2 Goal

Implement the RPC channel and the first two Python-side builtins:

- `kb_search(query, k=5, scope="wiki")`
- `kb_read(path)`

The Python REPL host must be able to call these builtins during a running `exec()` block, suspend execution, round-trip to the TypeScript extension, perform the real work there, and resume with the returned value.

Phase 2 is still a debug/raw-REPL phase. It does not yet implement the investigator loop, `FINAL()`, `llm_query()`, `rlm_query()`, budget tracking, or context preloading.

---

## 1. Architecture Recap: RPC During a Running Exec

The REPL still allows only one in-flight `exec()` at a time. While that exec is running, Python user code may call RPC-backed builtins.

Conceptual flow:

    Extension (TS)                                   Python host
         |                                                 |
         |---- exec { id: 1, code } ---------------------->|
         |                                                 | exec(code, namespace)
         |                                                 |   kb_search(...)
         |                                                 |   writes rpc request
         |<--- {"type":"rpc","id":1,"method":"kb_search"}--|
         |                                                 |
         |  handle RPC while pendingExec remains active    |
         |  call agentkb from TypeScript                   |
         |                                                 |
         |---- {"type":"rpc_response","id":1,...} -------->|
         |                                                 | kb_search returns
         |                                                 | exec continues
         |<--- {"type":"result","id":1,...} ---------------|

Important clarification:

- `repl.ts` keeps the original `pendingExec` active while RPC side-requests are handled.
- RPC messages are side-requests associated with the currently running exec.
- `repl.ts` should not add a hard `awaiting_rpc` state.
- Python is blocked waiting for a specific `rpc_response`.
- TypeScript dispatches the RPC asynchronously and resolves the original `exec()` only when the final `result` envelope arrives.

This keeps the state machine simple:

- `starting`
- `idle`
- `executing`
- `closed`
- `failed`

RPC messages are only valid while `pendingExec` exists.

---

## 2. Protocol Messages

### Python -> TypeScript

RPC request:

    {
      "type": "rpc",
      "id": 1,
      "method": "kb_search",
      "args": {
        "query": "azure setup",
        "k": 5,
        "scope": "wiki"
      }
    }

Exec result:

    {
      "type": "result",
      "id": 1,
      "stdout": "...",
      "stderr": "...",
      "error": null,
      "final": null
    }

Ready message:

    {
      "type": "ready"
    }

### TypeScript -> Python

Exec request:

    {
      "type": "exec",
      "id": 1,
      "code": "..."
    }

RPC success response:

    {
      "type": "rpc_response",
      "id": 1,
      "ok": true,
      "value": [...]
    }

RPC error response:

    {
      "type": "rpc_response",
      "id": 1,
      "ok": false,
      "error": "kb_search: query must be a non-empty string"
    }

Shutdown request:

    {
      "type": "shutdown"
    }

---

## 3. File-by-File Plan

---

## 3.1 `host.py` — Add RPC Shims and Namespace Preloading

### Current Phase 1 State

`host.py` already:

- Starts a Python subprocess.
- Emits `{"type":"ready"}`.
- Reads NDJSON protocol messages from stdin.
- Executes code in a persistent namespace.
- Captures user stdout/stderr.
- Returns `result` envelopes.
- Survives exceptions and `SystemExit`.

### Phase 2 Changes

Add:

- Strict `_rpc_call()` helper.
- `kb_search()` shim.
- `kb_read()` shim.
- Preserved protocol stdout handle.
- Disabled `input()`.
- Main-thread-only RPC guard.
- Host capability marker variables.

---

### 3.1.1 Preserve Protocol Stdout

The host must preserve the original stdout before redirecting user stdout.

Implementation invariant:

- `_PROTOCOL_OUT` is captured before user-code stdout redirection.
- `_send_protocol()` always writes to `_PROTOCOL_OUT`.
- `_send_protocol()` always flushes.
- User `print()` output remains captured in `io.StringIO`.
- Protocol JSON never goes through captured user stdout.

Suggested structure:

    _PROTOCOL_OUT = sys.stdout

    def _send_protocol(obj):
        _PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _PROTOCOL_OUT.flush()

Keep this explicitly in the Phase 2 plan even if Phase 1 already has something similar.

---

### 3.1.2 Strict RPC Call Helper

Add a global RPC ID counter and a helper:

    _rpc_id_counter = itertools.count(1)

    def _next_rpc_id():
        return next(_rpc_id_counter)

    def _rpc_call(method, args):
        _assert_main_thread_rpc()

        rpc_id = _next_rpc_id()
        _send_protocol({
            "type": "rpc",
            "id": rpc_id,
            "method": method,
            "args": args,
        })

        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("Python host stdin closed while waiting for RPC response")

        try:
            resp = json.loads(line)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid RPC response JSON: {line!r}") from e

        if resp.get("type") != "rpc_response":
            raise RuntimeError(f"Expected rpc_response for RPC {rpc_id}, got: {resp!r}")

        if resp.get("id") != rpc_id:
            raise RuntimeError(
                f"RPC response id mismatch: expected {rpc_id}, got {resp.get('id')}"
            )

        if not resp.get("ok"):
            raise RuntimeError(str(resp.get("error") or "RPC error"))

        return resp.get("value")

Do not silently ignore malformed JSON or mismatched response IDs. These are protocol errors and should become clear Python exceptions.

---

### 3.1.3 Python Builtin Shims

Preload these into the persistent namespace:

    def kb_search(query, k=5, scope="wiki"):
        """Search the local knowledge base. Returns a list of hit dictionaries."""
        return _rpc_call("kb_search", {
            "query": query,
            "k": k,
            "scope": scope,
        })

    def kb_read(path):
        """Read a knowledge-base file by path. Returns full text."""
        return _rpc_call("kb_read", {
            "path": path,
        })

Add to namespace:

    namespace["kb_search"] = kb_search
    namespace["kb_read"] = kb_read

---

### 3.1.4 Disable `input()`

`input()` reads from stdin, which is also the protocol channel. If generated Python code calls `input()`, it can corrupt the protocol or hang the REPL.

Disable it explicitly:

    def _disabled_input(*args, **kwargs):
        raise RuntimeError("input() is disabled in the RLM REPL host")

    namespace["input"] = _disabled_input

---

### 3.1.5 Main-Thread-Only RPC Guard

RPC builtins are only supported from the main REPL thread.

Reason:

- `sys.stdin` is a single shared stream.
- If multiple Python threads call `kb_search()` or `kb_read()` concurrently, one thread may consume another thread’s `rpc_response`.
- This can cause ID mismatches, hangs, or protocol corruption.

Add:

    _MAIN_THREAD_ID = threading.get_ident()

    def _assert_main_thread_rpc():
        if threading.get_ident() != _MAIN_THREAD_ID:
            raise RuntimeError(
                "RPC builtins may only be called from the main REPL thread. "
                "Use sequential calls, or a future batched builtin, instead of "
                "calling kb_search()/kb_read() from worker threads."
            )

Call `_assert_main_thread_rpc()` at the start of `_rpc_call()`.

Parallel fan-out should be implemented later as explicit TypeScript-managed batched builtins, not by arbitrary Python threads.

---

### 3.1.6 Add Host Capability Markers

Add small introspection markers for testing and debugging:

    namespace["_RLM_HOST_PHASE"] = 2
    namespace["_RLM_BUILTINS"] = ["kb_search", "kb_read"]

This makes it easy to verify that the Phase 2 host booted correctly.

---

## 3.2 `repl.ts` — Handle RPC Messages from Python

### Current Phase 1 State

`repl.ts` already:

- Spawns `host.py`.
- Reads stdout line-by-line as NDJSON.
- Waits for `ready`.
- Sends `exec` requests.
- Matches result IDs.
- Enforces one in-flight exec.
- Supports timeouts and abort handling.
- Captures child stderr diagnostics.
- Closes the subprocess gracefully.

### Phase 2 Changes

Add:

- Typed RPC handler registry.
- `type: "rpc"` handling while `pendingExec` remains active.
- Per-RPC timeout.
- Unknown method handling as Python-visible RPC error.
- Minimum guard against writing to a closed process.
- Strict shape validation for RPC messages.

---

### 3.2.1 RPC Handler Types

Add reusable types:

    export type RpcHandler = (args: unknown) => Promise<unknown> | unknown;

    export type RpcHandlers = Record<string, RpcHandler>;

Add to `PythonRepl`:

    private rpcHandlers: RpcHandlers = {};

    setRpcHandlers(handlers: RpcHandlers): void {
      this.rpcHandlers = { ...handlers };
    }

---

### 3.2.2 RPC Message Handling

Extend `handleLine` so that:

- `ready` is handled as before.
- `result` is handled as before.
- `rpc` is handled only if an exec is pending.
- Unknown protocol types remain fatal protocol errors.

Conceptual logic:

    if (msg.type === "rpc") {
      if (!this.pendingExec) {
        this.fail(new Error("Received RPC message with no pending exec"));
        return;
      }

      void this.handleRpcMessage(msg);
      return;
    }

Do not resolve `pendingExec` when an RPC arrives. The exec resolves only when the final `result` message arrives.

---

### 3.2.3 Unknown RPC Methods

Unknown methods should not be fatal to the whole REPL.

Instead, return an RPC error to Python:

    {
      "type": "rpc_response",
      "id": rpcId,
      "ok": false,
      "error": "Unknown RPC method: some_method"
    }

Python will raise a `RuntimeError`, and the block result will contain a normal Python traceback.

Fatal protocol errors should be reserved for malformed messages, invalid IDs, result ID mismatches, subprocess crashes, or impossible state transitions.

---

### 3.2.4 RPC Timeout

Add a per-RPC timeout.

Extend options:

    interface PythonReplOptions {
      pythonPath?: string;
      startupTimeoutMs?: number;
      execTimeoutMs?: number;
      shutdownTimeoutMs?: number;
      rpcTimeoutMs?: number;
    }

Default suggestion:

- `rpcTimeoutMs = 60_000`

RPC timeout behavior:

- If a handler does not finish within `rpcTimeoutMs`, send `ok:false` back to Python.
- Do not immediately kill the REPL just because one RPC timed out.
- The Python shim raises a `RuntimeError`, and the exec result contains the traceback.

Example error:

    RPC kb_search timed out after 60000ms

The overall exec timeout still remains the outer safety net.

---

### 3.2.5 Minimum Guard for Write-After-Close

RPC handlers are async. A handler may finish after the process was closed or killed.

Before writing an `rpc_response`, guard minimally:

    if (this.closed || !this.child.stdin?.writable) {
      return;
    }

If the process is already gone, do not throw from a late async handler.

---

### 3.2.6 Strict RPC Shape Validation

For incoming RPC messages, validate:

- `id` is an integer number.
- `method` is a non-empty string.
- `args` is present or defaulted to `{}`.

Malformed RPC messages from Python should be treated as fatal protocol errors because they indicate host corruption or a bug.

Exec result ID matching remains strict as in Phase 1.

---

## 3.3 `agentkb.ts` — Shell Out to AgentKB Venv

Create new file:

    .pi/extensions/rlm/agentkb.ts

### Purpose

Centralize all `agentkb` access in one TypeScript module.

The Python host never invokes `agentkb` directly. It only sends RPC requests to the extension.

---

### 3.3.1 Options

Define:

    export interface AgentKBOptions {
      pythonPath: string;
      agentkbCwd: string;
      timeoutMs?: number;
      restrictReadRoot?: string;
      signal?: AbortSignal;
    }

Defaults used by the extension:

    const DEFAULT_AGENTKB_CWD = "C:\\Appl\\workspace\\Python\\agentkb";
    const DEFAULT_AGENTKB_PYTHON =
      "C:\\Appl\\workspace\\Python\\agentkb\\venv\\Scripts\\python.exe";

`restrictReadRoot` should default to `agentkbCwd`.

---

### 3.3.2 Search Invocation

Never call the bare `agentkb` executable.

Use the configured venv Python:

    pythonPath -m agentkb search --json -k <k> -s <scope> <query>

Use `execFile` or `spawn` with an argv array. Do not build a shell string.

Conceptual argv:

    [
      "-m",
      "agentkb",
      "search",
      "--json",
      "-k",
      String(k),
      "-s",
      scope,
      query
    ]

Important:

- Do not quote `query` manually.
- Passing `query` as an argv element is the quoting.
- Use `cwd: agentkbCwd`.
- Use `windowsHide: true`.

Whether to use `execFile` or `spawn` can follow the existing repo pattern. Keep this open during implementation, but preserve the argv-array requirement.

---

### 3.3.3 `kbSearch()`

Signature:

    export async function kbSearch(
      options: AgentKBOptions,
      query: string,
      k = 5,
      scope = "wiki"
    ): Promise<AgentKBHit[]>;

Behavior:

- Validate and clamp `k`.
- Run `agentkb search`.
- Parse JSON output.
- Expect `{ results: [...] }`.
- Normalize hits.
- Skip invalid hits instead of failing the whole search.

---

### 3.3.4 `k` Validation

Validate before invoking the CLI:

    const safeK = Number(k);

    if (!Number.isFinite(safeK)) {
      throw new Error("kb_search: k must be a number");
    }

    const normalizedK = Math.trunc(safeK);

    if (normalizedK < 1 || normalizedK > 50) {
      throw new Error("kb_search: k must be between 1 and 50");
    }

Use `normalizedK` for the CLI.

---

### 3.3.5 JSON Parsing Helper

Use strict JSON parsing first.

If strict parsing fails, attempt improved diagnostics and optional extraction of the first JSON object.

Suggested helper behavior:

1. Try `JSON.parse(stdout)`.
2. If that fails:
   - Try to extract a JSON object from stdout, for example from the first `{` to the last `}`.
   - Try `JSON.parse()` on that slice.
3. If that also fails:
   - Throw an error containing capped stdout and stderr excerpts.

Example error shape:

    Failed to parse agentkb JSON output.
    stderr:
    <capped stderr>

    stdout:
    <capped stdout>

Keep diagnostics capped, e.g. 4,000 characters each, to avoid flooding the Pi UI.

---

### 3.3.6 Hit Normalization

Define:

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

Mapping rules:

- Prefer `raw.path`.
- Fall back to `raw.file`.
- If neither is a non-empty string, skip the hit.
- Preserve useful optional fields if present.
- Do not fail the whole search because one result is malformed.

Example normalization:

    const hitPath = raw.path ?? raw.file;

    if (typeof hitPath !== "string" || !hitPath.trim()) {
      continue;
    }

    hits.push({
      path: hitPath,
      file: typeof raw.file === "string" ? raw.file : undefined,
      filename: typeof raw.filename === "string" ? raw.filename : undefined,
      score: typeof raw.score === "number" ? raw.score : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
      section: typeof raw.section === "string" ? raw.section : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === "string") : undefined,
      snippet: typeof raw.snippet === "string" ? raw.snippet : undefined,
    });

---

### 3.3.7 `kbRead()` with Configurable Root Restriction

Signature:

    export async function kbRead(
      options: AgentKBOptions,
      filePath: string
    ): Promise<string>;

Behavior:

- Read the file directly with Node `fs.promises.readFile`.
- Restrict reads to the configured root directory.
- Default root is `options.restrictReadRoot ?? options.agentkbCwd`.
- Resolve paths before checking.
- Reject paths outside the configured root.

Recommended behavior:

    const root = path.resolve(options.restrictReadRoot ?? options.agentkbCwd);
    const resolved = path.resolve(filePath);

    const rootCmp = process.platform === "win32" ? root.toLowerCase() : root;
    const resolvedCmp = process.platform === "win32" ? resolved.toLowerCase() : resolved;

    if (resolvedCmp !== rootCmp && !resolvedCmp.startsWith(rootCmp + path.sep)) {
      throw new Error("kb_read path is outside the configured agentkb root");
    }

    return await fs.promises.readFile(resolved, "utf8");

Note:

- This is intentionally stricter than unrestricted local file reading.
- If future agentkb hits point outside `agentkbCwd`, expose `restrictReadRoot` as a configurable setting.

---

## 3.4 `rpc.ts` — Builtin Dispatch Registry

Create new file:

    .pi/extensions/rlm/rpc.ts

### Purpose

Bridge generic REPL RPC dispatch to concrete builtins.

`repl.ts` should not know about `agentkb`.

---

### 3.4.1 Helper Validation

Add:

    function asRecord(value: unknown, name: string): Record<string, unknown> {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name}: args must be an object`);
      }

      return value as Record<string, unknown>;
    }

---

### 3.4.2 Handler Factory

Define:

    export function createRpcHandlers(options: AgentKBOptions): RpcHandlers {
      return {
        async kb_search(args: unknown) {
          const obj = asRecord(args, "kb_search");

          const query = obj.query;
          if (typeof query !== "string" || !query.trim()) {
            throw new Error("kb_search: query must be a non-empty string");
          }

          const kRaw = obj.k ?? 5;
          const k = Number(kRaw);
          if (!Number.isFinite(k)) {
            throw new Error("kb_search: k must be a number");
          }

          const scopeRaw = obj.scope ?? "wiki";
          if (typeof scopeRaw !== "string" || !scopeRaw.trim()) {
            throw new Error("kb_search: scope must be a non-empty string");
          }

          return kbSearch(options, query, Math.trunc(k), scopeRaw);
        },

        async kb_read(args: unknown) {
          const obj = asRecord(args, "kb_read");

          const filePath = obj.path;
          if (typeof filePath !== "string" || !filePath.trim()) {
            throw new Error("kb_read: path must be a non-empty string");
          }

          return kbRead(options, filePath);
        },
      };
    }

`rpc.ts` handles argument validation. `agentkb.ts` still performs its own defensive validation too.

---

## 3.5 `index.ts` — Temporary Phase 2 Debug Tool Update

Update the temporary Phase 1 tool so it wires in the Phase 2 builtins.

This is still not the final RLM investigator tool.

Suggested tool description:

    Temporary Phase 2 debug tool: executes one Python block in the RLM REPL with
    kb_search/kb_read builtins. Not the final rlm_query investigator loop.

Suggested params:

- `code: string`
- `timeoutMs?: number`
- `pythonPath?: string`
- `agentkbPythonPath?: string`
- `agentkbCwd?: string`
- `restrictReadRoot?: string`

Behavior:

1. Create `PythonRepl`.
2. Set RPC handlers with `createRpcHandlers()`.
3. Await `ready()`.
4. Run one `exec(code)`.
5. Close in `finally`.
6. Return formatted stdout/stderr/error text.

Example debug code users can run:

    print(_RLM_HOST_PHASE)
    print(_RLM_BUILTINS)
    hits = kb_search("installation", k=2)
    print(len(hits))
    if hits:
        print(hits[0]["path"])
        text = kb_read(hits[0]["path"])
        print(text[:500])

---

## 4. Data Flow Example

User code:

    print("before")
    results = kb_search("azure setup", k=3)
    print(len(results))
    text = kb_read(results[0]["path"])
    print(text[:100])
    print("after")

Step-by-step:

1. TypeScript sends `{"type":"exec","id":1,"code":"..."}`.
2. Python outer loop reads the exec request.
3. Python runs `exec(code, namespace)`.
4. User code prints `"before"` into captured stdout.
5. User code calls `kb_search(...)`.
6. Python shim sends `{"type":"rpc","id":1,"method":"kb_search","args":...}` to protocol stdout.
7. Python blocks on `sys.stdin.readline()`.
8. TypeScript receives the RPC message while `pendingExec` remains active.
9. TypeScript dispatches `kb_search` through `rpc.ts`.
10. `agentkb.ts` invokes the configured venv Python with `-m agentkb search`.
11. TypeScript sends `{"type":"rpc_response","id":1,"ok":true,"value":[...]}`.
12. Python unblocks and returns the list to user code.
13. User code prints result count.
14. User code calls `kb_read(...)`.
15. A second RPC round-trip happens.
16. User code prints text prefix and `"after"`.
17. Python finishes exec and sends `{"type":"result","id":1,...}`.
18. TypeScript resolves the exec promise.

Expected stdout ordering:

    before
    3
    <first 100 chars>
    after

---

## 5. Edge Cases and Handling

| Edge case | Handling |
|---|---|
| Malformed RPC response JSON in Python | `_rpc_call()` raises `RuntimeError` with raw line excerpt. |
| Wrong RPC response ID | `_rpc_call()` raises `RuntimeError` with expected/actual IDs. |
| RPC response has `ok:false` | Python shim raises `RuntimeError(error)`. |
| Unknown RPC method | TypeScript sends `ok:false`; Python raises normally. |
| RPC arrives with no pending exec | Fatal protocol error in `repl.ts`. |
| Malformed RPC message from Python | Fatal protocol error in `repl.ts`. |
| `agentkb` exits non-zero | `agentkb.ts` throws with capped stdout/stderr diagnostics; RPC returns `ok:false`. |
| `agentkb` emits non-strict JSON | Try strict parse first, then improved extraction; if still invalid, throw with diagnostics. |
| Invalid search hit without path/file | Skip that hit. |
| `kb_read` path outside configured root | Throw `kb_read path is outside the configured agentkb root`. |
| User code calls `input()` | Disabled; raises clear `RuntimeError`. |
| User code calls RPC builtin from worker thread | Main-thread guard raises clear `RuntimeError`. |
| RPC handler hangs | Per-RPC timeout returns `ok:false`; Python receives traceback. |
| Exec timeout during RPC | Existing exec timeout kills/fails subprocess. |
| RPC handler finishes after close | Minimum write guard prevents late async crash. |
| Multiple sequential RPC calls in one block | Supported. |
| Multiple concurrent Python-thread RPC calls | Unsupported by design; rejected by main-thread guard. |

---

## 6. Testing Plan

Split Phase 2 tests into two parts:

1. Deterministic protocol tests with mock RPC handlers.
2. Optional real `agentkb` integration tests.

The real `agentkb` tests should be executed separately because they depend on the corporate machine setup and local KB contents.

---

## 6.1 `test-phase2.ts` — Mock RPC Protocol Tests

Create:

    .pi/extensions/rlm/test-phase2.ts

These tests should not require `agentkb`.

Use mock handlers:

    repl.setRpcHandlers({
      kb_search: async args => [
        {
          path: "C:\\Appl\\workspace\\Python\\agentkb\\wiki\\mock.md",
          score: 1,
          title: "Mock Result"
        }
      ],
      kb_read: async args => "Mock file content"
    });

Recommended tests:

1. Host boots and exposes `_RLM_HOST_PHASE == 2`.
2. Host exposes `_RLM_BUILTINS` containing `kb_search` and `kb_read`.
3. `kb_search("test", k=2)` returns a list from the mock handler.
4. `kb_read(path)` returns a string from the mock handler.
5. Multiple sequential RPC calls in one exec work.
6. Print before and after RPC preserves stdout ordering.
7. RPC handler throws and Python result contains a traceback with `RuntimeError`.
8. Unknown RPC method returns Python-visible error, if exposed via a test shim.
9. Concurrent `exec()` is still rejected while one exec is active.
10. RPC timeout returns a Python-visible error.
11. `input()` is disabled.
12. RPC from non-main thread raises the main-thread-only guard error.

Example test snippet for stdout ordering:

    print("before")
    hits = kb_search("mock", k=1)
    print("middle", len(hits))
    text = kb_read(hits[0]["path"])
    print("after", text[:4])

Expected stdout:

    before
    middle 1
    after Mock

---

## 6.2 `test-phase2-agentkb.ts` — Optional Real AgentKB Integration Tests

Create:

    .pi/extensions/rlm/test-phase2-agentkb.ts

These tests require the real corporate local setup:

- `C:\Appl\workspace\Python\agentkb`
- `C:\Appl\workspace\Python\agentkb\venv\Scripts\python.exe`
- A working local `agentkb` installation.
- Local KB content.

Gate execution explicitly, for example:

    RLM_AGENTKB_TESTS=1

If the variable is not set, print a skip message and exit successfully.

Recommended tests:

1. `kb_search("installation", k=2)` returns an array.
2. Valid hits contain a usable `path`.
3. `kb_read(firstHit.path)` returns non-empty text.
4. Invalid scope surfaces a clean error.
5. Nonexistent read path surfaces a clean error.
6. Path outside configured root is rejected.
7. Compound block: `kb_search()` followed by `kb_read(results[0]["path"])`.

Important:

- Do not make these tests part of mandatory CI unless the corporate KB setup is guaranteed.
- The mock test suite is the mandatory Phase 2 protocol verification.

---

## 7. Manual Single-Turn Debug Test

After implementation, manually run the temporary debug tool with:

    print(_RLM_HOST_PHASE)
    print(_RLM_BUILTINS)

    hits = kb_search("installation", k=2)
    print("hits", len(hits))

    for h in hits:
        print(h.get("score"), h.get("path"))

    if hits:
        text = kb_read(hits[0]["path"])
        print("chars", len(text))
        print(text[:500])

Expected behavior:

- `_RLM_HOST_PHASE` prints `2`.
- `_RLM_BUILTINS` includes `kb_search` and `kb_read`.
- Search returns zero or more valid normalized hit dictionaries.
- If a hit exists, read returns file text.
- No protocol JSON appears in captured stdout.

---

## 8. Deliverables Checklist

- [ ] `host.py` extended with `kb_search` / `kb_read` shims.
- [ ] `host.py` includes strict `_rpc_call()` helper.
- [ ] `host.py` preserves protocol stdout via `_PROTOCOL_OUT`.
- [ ] `host.py` disables `input()` to avoid protocol stdin corruption.
- [ ] `host.py` enforces RPC builtins are called only from the main REPL thread.
- [ ] `host.py` adds `_RLM_HOST_PHASE = 2`.
- [ ] `host.py` adds `_RLM_BUILTINS = ["kb_search", "kb_read"]`.
- [ ] `repl.ts` handles `type:"rpc"` while `pendingExec` remains active.
- [ ] `repl.ts` does not add `awaiting_rpc` as a hard state.
- [ ] `repl.ts` adds `RpcHandler` and `RpcHandlers` typings.
- [ ] `repl.ts` adds `setRpcHandlers()`.
- [ ] `repl.ts` returns `ok:false` for unknown RPC methods.
- [ ] `repl.ts` adds per-RPC timeout.
- [ ] `repl.ts` guards against write-after-close for late RPC responses.
- [ ] `repl.ts` validates incoming RPC message shape strictly.
- [ ] `repl.ts` keeps exec result ID matching strict.
- [ ] `agentkb.ts` created.
- [ ] `agentkb.ts` invokes venv Python with `-m agentkb`, never the bare `agentkb` executable.
- [ ] `agentkb.ts` uses argv-array invocation, not shell string interpolation.
- [ ] `agentkb.ts` supports configurable `pythonPath`.
- [ ] `agentkb.ts` supports configurable `agentkbCwd`.
- [ ] `agentkb.ts` supports configurable read restriction root.
- [ ] `agentkb.ts` validates `k` as integer range `1..50`.
- [ ] `agentkb.ts` parses JSON strictly first, then attempts improved extraction/diagnostics.
- [ ] `agentkb.ts` caps stdout/stderr diagnostics.
- [ ] `agentkb.ts` normalizes `path` / `file` fields.
- [ ] `agentkb.ts` skips invalid hits instead of failing the whole search.
- [ ] `agentkb.ts` restricts `kb_read` to the configured root directory.
- [ ] `rpc.ts` created.
- [ ] `rpc.ts` includes `asRecord()` validation helper.
- [ ] `rpc.ts` implements `createRpcHandlers()`.
- [ ] `rpc.ts` validates `kb_search` args strictly.
- [ ] `rpc.ts` validates `kb_read` args strictly.
- [ ] `index.ts` updated with temporary Phase 2 debug tool wiring in KB builtins.
- [ ] `index.ts` tool description clearly says this is not the final investigator loop.
- [ ] `test-phase2.ts` created with deterministic mock-handler protocol tests.
- [ ] `test-phase2-agentkb.ts` created as optional real integration tests.
- [ ] Optional integration tests are gated and executed separately.
- [ ] Manual single-turn debug test verified.

---

## 9. Deferred to Later Phases

Phase 2 does not implement:

- Investigator loop.
- Prompt construction.
- Initial `context` variable.
- `FINAL()`.
- `FINAL_VAR()`.
- `SHOW_VARS()`.
- `llm_query()`.
- `llm_query_batched()`.
- `rlm_query()`.
- `rlm_query_batched()`.
- Budget tracking.
- Recursion.
- NDJSON run logging.
- Rich `renderCall` / `renderResult`.
- Jupyter export.

---

## 10. Phase 2 Completion Criteria

Phase 2 is complete when:

1. Mock protocol tests pass reliably without a real `agentkb` installation.
2. Optional real `agentkb` integration tests pass on the corporate machine.
3. The temporary debug tool can execute one Python block that:
   - calls `kb_search()`,
   - receives normalized hit dictionaries,
   - calls `kb_read()` on an allowed path,
   - prints captured output in the correct order,
   - returns a final `result` envelope without leaking protocol JSON into stdout.
4. Error cases produce clear Python-visible tracebacks instead of hangs.
5. The subprocess still shuts down cleanly after the exec completes or fails.