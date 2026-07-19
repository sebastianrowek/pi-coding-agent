# RLM Extension — Phase 3 Implementation Plan

## Phase 3 Goal

Turn the Phase 2 raw-REPL debug tool into the actual RLM investigator: an LLM that
answers a natural-language question by iteratively writing Python into the persistent
REPL, observing captured output, and finishing with `FINAL()`.

Per the PLAN.md build order, Phase 3 covers:

- The investigator turn loop (`investigator.ts`) driven by `complete()` calls.
- The system prompt (`prompt.ts`).
- `FINAL()`, `FINAL_VAR()`, `SHOW_VARS()` builtins in the host.
- Preloading the `context` variable from an initial `kb_search`.
- Rewriting `index.ts` so `rlm_query` takes a `prompt` (question), not raw `code`.
- End-to-end: one real query through Pi.

Phase 3 does **not** implement (deferred to Phases 4–6):

- `llm_query()` / `llm_query_batched()` (Phase 4)
- The shared cross-tree budget tracker and investigator/analyst model split (Phase 4)
- `rlm_query()` / `rlm_query_batched()` recursion (Phase 5)
- NDJSON run logging, rich `renderCall` / `renderResult`, `promptSnippet` /
  `promptGuidelines` (Phase 6)
- Jupyter export (deferred indefinitely)

Phase 3 **does** include a *simple* per-run budget cap (sum of `complete()` costs vs.
`maxBudget`), because "budget exhausted" is one of the loop's exit conditions. The full
shared-budget tree (children draw from the parent's remainder, parallel siblings) stays
in Phase 4.

---

## 1. Current State (verified against the code)

- `host.py` — persistent namespace, NDJSON protocol, `_rpc_call()` with strict ID
  matching, `kb_search`/`kb_read` shims, `input()` disabled, main-thread RPC guard,
  `_RLM_HOST_PHASE = 2`. The `result` envelope already carries `final: None`.
- `repl.ts` — `PythonRepl` with states `starting | ready | executing | closed | failed`,
  one in-flight exec, RPC dispatch while `pendingExec` stays active, per-RPC timeout,
  write-after-close guard. `ExecResult` already has `final?: string | null` and
  `handleLine` already parses it.
- `agentkb.ts` — `kbSearch()` / `kbRead()` via the venv Python, hit normalization,
  read-root restriction. `kbSearch` is directly callable from TypeScript — Phase 3
  reuses it for the initial `context` search.
- `rpc.ts` — `createRpcHandlers(options)` returning `kb_search` / `kb_read` handlers.
- `index.ts` — temporary Phase 2 debug tool (`code` param, one exec, formatted output).

Verified API surfaces for Phase 3:

- Tool execute signature: `execute(toolCallId, params, signal, onUpdate, ctx)` where
  `ctx: ExtensionContext` has `modelRegistry: ModelRegistry`
  (`packages/coding-agent/src/core/extensions/types.ts:463`, `:312`).
- `ctx.modelRegistry.find(provider, modelId): Model<Api> | undefined`
  (`packages/coding-agent/src/core/model-registry.ts:707`).
- `ctx.modelRegistry.getApiKeyAndHeaders(model): Promise<ResolvedRequestAuth>`
  (`model-registry.ts:757`).
- `complete(model, context, options): Promise<AssistantMessage>` from
  `@earendil-works/pi-ai` (`packages/ai/src/stream.ts:49`). `Context` is
  `{ systemPrompt?, messages, tools? }`; `StreamOptions` includes `signal`, `maxTokens`,
  `apiKey`, and `headers` (`packages/ai/src/types.ts:87`, `:125`).
- `AssistantMessage` has `content: (TextContent | ThinkingContent | ToolCall)[]`,
  `usage.cost.total`, `stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"`,
  and `errorMessage` (`types.ts:288`). **`complete()` resolves with
  `stopReason: "error" | "aborted"` instead of throwing** — the loop must check this.
- `UserMessage` requires a `timestamp` (ms) field (`types.ts:282`).

Model defaults (locked in PLAN.md): investigator = `azure-foundry/Kimi-K2.6`, resolved
through the runtime model registry, **never** the static `getModel()`. `azure-foundry`
has `compat.supportsReasoningEffort: false` — do not pass `reasoningEffort`.

> Note: PLAN.md names the analyst default as `gpt-5.4-mini` in one place and
> `gpt-5.4-nano` in the locked decisions. The analyst model is Phase 4 scope; resolve
> the discrepancy then (the locked-decisions section, `gpt-5.4-nano`, should win unless
> the user says otherwise).

---

## 2. File-by-File Plan

```text
.pi/extensions/rlm/
  host.py            extend: FINAL/FINAL_VAR/SHOW_VARS, set_var message, phase marker 3
  repl.ts            extend: setVar(), final already plumbed
  prompt.ts          NEW: system prompt builder
  investigator.ts    NEW: the turn loop
  index.ts           rewrite: real rlm_query tool (prompt param)
  test-phase3.ts     NEW: deterministic loop tests with a fake complete()
  PHASE3.md          this plan
```

`agentkb.ts` and `rpc.ts` need no changes.

---

## 2.1 `host.py` — Final-Answer Builtins and `set_var`

### 2.1.1 `FINAL(answer)` — sentinel-exception semantics

`FINAL()` must stop the rest of the block deterministically, not just set a flag:

```python
class _RlmFinal(BaseException):
    """Control-flow signal: FINAL() was called. Not an error."""

_final_value = None

def FINAL(answer):
    global _final_value
    if isinstance(answer, str):
        _final_value = answer
    else:
        try:
            _final_value = json.dumps(answer, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            _final_value = str(answer)
    raise _RlmFinal()
```

Rules:

- Derives from `BaseException` so user `except Exception:` blocks cannot swallow it
  accidentally. (A user `except BaseException:` still can — acceptable; the value is
  already stored before the raise, and the host reads `_final_value` regardless.)
- Non-string answers are serialized: `json.dumps(..., default=str)` first, `str()` as
  fallback. The protocol `final` field stays a string.
- `_final_value` is reset to `None` at the start of every `exec` handling, so a stale
  final from an aborted earlier block can never leak into a later result.

### 2.1.2 Exec handler changes

In the exec `try`, catch the sentinel *before* `BaseException`:

```python
exc = None
try:
    exec(req.get("code", ""), namespace)
except _RlmFinal:
    pass  # final answer set; not an error
except BaseException:
    exc = traceback.format_exc()
```

Result envelope: `"final": _final_value` (string or `None`), `"error": exc`. If user
code caught `_RlmFinal` and then crashed later, both `final` and `error` can be set —
the investigator treats `final` as authoritative.

### 2.1.3 `FINAL_VAR(name)`

```python
def FINAL_VAR(name):
    if not isinstance(name, str):
        raise TypeError("FINAL_VAR expects a variable name string")
    if name not in namespace:
        raise NameError(f"FINAL_VAR: no variable named {name!r} in the REPL namespace")
    FINAL(namespace[name])
```

### 2.1.4 `SHOW_VARS()`

Pure-Python, no RPC. Returns (not prints) a summary string of user-defined namespace
entries:

- Skip the preinstalled entries (builtins/shims/markers). Easiest: record the initial
  key set right after namespace construction (`_INITIAL_KEYS = set(namespace)`) and
  skip those plus dunder names.
- For each remaining var: `name: type — repr capped at ~200 chars`.
- Return `"(no user variables)"` when empty.

### 2.1.5 `set_var` protocol message

New stdin message type, handled in the outer loop next to `exec`:

```json
{ "type": "set_var", "id": 7, "name": "context", "value": [ ... ] }
```

Handling:

- `namespace[name] = value` (the JSON value as parsed — lists/dicts/strings arrive as
  native Python objects; no string-escaping problems, which is why this is a protocol
  message and not a generated `exec` block).
- Reply with a normal `result` envelope: `{"type": "result", "id": 7, "stdout": "",
  "stderr": "", "error": null, "final": null}`. Invalid `name` (non-string/empty) →
  same envelope with `error` set.

This reuses the existing single-pending-request machinery on both sides; no new
response type.

### 2.1.6 Markers

- `_RLM_HOST_PHASE = 3`
- `_RLM_BUILTINS = ["kb_search", "kb_read", "FINAL", "FINAL_VAR", "SHOW_VARS"]`
- Add `FINAL`, `FINAL_VAR`, `SHOW_VARS` to the namespace dict.

---

## 2.2 `repl.ts` — `setVar()`

Add one public method:

```typescript
setVar(name: string, value: unknown): Promise<void>
```

Behavior:

- Same preconditions as `exec()` (ready, no pending request, process alive).
- Sends `{ type: "set_var", id, name, value }` and waits for the matching `result`
  envelope through the existing `pendingExec` path (the host replies with a result, so
  no new message type on the read side). If the result carries `error`, reject.
- Refactor note: `exec()` and `setVar()` share the "send request, arm timeout, await
  matching result" logic — extract a private `sendRequest(msg)` helper rather than
  duplicating it. Keep `exec()`'s public signature unchanged.

No state-machine changes. `final` parsing already exists.

Known quirk from PHASE2-NOTES still stands: `close()` while Python is blocked inside
`_rpc_call` relies on the kill timer. Phase 3's cancellation path (Esc) aborts via
`signal` → `fail()` → `kill()`, which is fine; no fix required yet.

---

## 2.3 `prompt.ts` — System Prompt (NEW)

Export:

```typescript
export interface PromptOptions {
  question: string;
  contextCount: number;        // number of preloaded hits (0 if search failed/empty)
  contextNote?: string;        // e.g. "initial kb_search failed: <reason>"
  maxTurns: number;
  outputCapChars: number;
}

export function buildSystemPrompt(opts: PromptOptions): string;
```

Prompt content (single template literal, technical tone, no emojis):

1. **Role**: "You are an investigator answering a question by writing Python in a
   persistent REPL. State persists across turns (variables, imports, functions)."
2. **Protocol**: every reply must contain exactly one fenced ` ```python ` block; only
   the **last** fenced block is executed. Text outside the block is your reasoning and
   is kept short. A reply with **no** code block ends the investigation and is taken
   as the final answer (prefer `FINAL()` instead).
3. **Environment**:
   - `context`: list of dicts (`path`, `score`, `title`, `snippet`, …) from an initial
     knowledge-base search for the question; `len(context) == N`. If `contextNote` is
     set, state that the initial search failed and `context == []`.
   - `kb_search(query, k=5, scope="wiki")` → list of hit dicts.
   - `kb_read(path)` → full file text for a hit's `path`.
   - `FINAL(answer)` → end with this answer; stops the block immediately.
   - `FINAL_VAR(name)` → end with the value of the named REPL variable.
   - `SHOW_VARS()` → returns a summary string of your variables.
   - Full stdlib available. `input()` is disabled. No network, no pip.
4. **Rules of thumb**: `print()` what you need to see — bare expressions show nothing;
   output is capped at `outputCapChars` chars per turn, so slice large texts; you have
   at most `maxTurns` turns, finish with `FINAL()` before they run out; read promising
   hits with `kb_read` instead of trusting snippets.
5. **The question** is sent as the first user message, not embedded in the system
   prompt (keeps the system prompt cacheable across runs if desired later).

---

## 2.4 `investigator.ts` — Turn Loop (NEW)

### 2.4.1 Interface

```typescript
export interface InvestigatorEvent {
  type: "turn_start" | "assistant_text" | "code_block" | "exec_result" | "done";
  turn: number;
  text?: string;     // prose / code / capped output, depending on type
}

export interface InvestigationOptions {
  question: string;
  repl: PythonRepl;                    // ready, RPC handlers already set
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTurns: number;                    // default 12
  maxBudgetUsd: number;                // default 0.50
  outputCapChars: number;              // default 10_000
  signal?: AbortSignal;
  onEvent?: (ev: InvestigatorEvent) => void;
  completeFn?: typeof complete;        // injectable for tests; defaults to complete
}

export interface InvestigationResult {
  answer: string;
  stopReason: "final" | "no_code" | "max_turns" | "budget" | "error" | "aborted";
  turns: number;
  costUsd: number;
}

export async function runInvestigation(
  opts: InvestigationOptions,
): Promise<InvestigationResult>;
```

`completeFn` injection is what makes the loop testable without a provider; the default
is the real `complete` from `@earendil-works/pi-ai` (top-level import — no inline
imports per repo rules).

### 2.4.2 Loop algorithm

1. `messages = [{ role: "user", content: question, timestamp: Date.now() }]`.
2. For `turn = 1 .. maxTurns`:
   a. If `costUsd >= maxBudgetUsd` → stop with `stopReason: "budget"`, best-effort
      answer (see 2.4.5).
   b. `msg = await completeFn(model, { systemPrompt, messages }, { apiKey, headers, signal })`.
      No `reasoningEffort`, no `maxTokens` override (provider default).
   c. Add `msg.usage.cost.total` to `costUsd`. Append `msg` to `messages` (the
      `AssistantMessage` is a valid `Message`; do not flatten it to text).
   d. If `msg.stopReason === "aborted"` → `stopReason: "aborted"`. If `"error"` →
      `stopReason: "error"` with `msg.errorMessage` in the answer. (`complete()`
      reports these in-band; also wrap the call in try/catch for transport throws.)
   e. Concatenate the `TextContent` parts of `msg.content` (ignore thinking blocks).
      Emit `assistant_text`.
   f. Extract the **last** fenced Python code block (see 2.4.3). If none → return the
      assistant text as the answer, `stopReason: "no_code"`.
   g. `result = await repl.exec(code)`. Emit `code_block` and `exec_result`.
   h. If `result.final !== null` → return it, `stopReason: "final"`.
   i. Build the observation message (see 2.4.4), append as
      `{ role: "user", content: observation, timestamp: Date.now() }`.
3. Turns exhausted → `stopReason: "max_turns"`, best-effort answer.

### 2.4.3 Code-block extraction

```typescript
const FENCE_RE = /```(?:python|py)?\s*\n([\s\S]*?)```/g;
```

- Take the **last** match (models often show a plan block first, then the real one).
- A block that is empty/whitespace-only counts as "no code".
- An unterminated fence (no closing ```` ``` ````) is not a match — treated as no code.

### 2.4.4 Observation message (exec result → next user message)

Format, in order, skipping empty sections:

```text
stdout:
<stdout>

stderr:
<stderr>

error:
<traceback>
```

If everything is empty: `"(no output — use print() to see values)"`.

Capping at `outputCapChars` (default 10 000): keep the **first 70 %** and **last 20 %**
with a marker in between:

```text
... [output truncated: <N> chars omitted] ...
```

Head+tail beats head-only because tracebacks and loop summaries land at the end.

### 2.4.5 Best-effort answer on `max_turns` / `budget`

Do **not** spend another model call. Use the last assistant prose (turn ≥ 1 always has
one) prefixed with a one-line note, e.g.:

```text
[Investigation stopped: turn limit reached without FINAL(). Last reasoning state:]
<last assistant text>
```

A closing "summarize now" model call is a possible Phase 6 nicety; out of scope here.

### 2.4.6 Abort handling

- `signal` goes to `completeFn` (in-band `"aborted"` stop) and is already wired into
  `PythonRepl` (kills the subprocess, rejects pending exec).
- An exec rejection caused by abort → `stopReason: "aborted"`; any other exec
  rejection (REPL crash, timeout) → `stopReason: "error"` with the message in the
  answer. Distinguish via `signal?.aborted`.

---

## 2.5 `index.ts` — Real `rlm_query` Tool (rewrite)

Replaces the Phase 2 debug tool. (If keeping a raw-exec escape hatch is wanted for
debugging, that is a user decision — default plan: remove it; the Phase 2/3 test
scripts cover raw exec.)

### Params (TypeBox)

```typescript
{
  prompt: Type.String(),                       // the question
  scope: Type.Optional(Type.String()),         // initial kb_search scope, default "wiki"
  k: Type.Optional(Type.Number()),             // initial kb_search k, default 5
  maxTurns: Type.Optional(Type.Number()),      // default 12
  maxBudget: Type.Optional(Type.Number()),     // USD, default 0.50
  investigatorProvider: Type.Optional(Type.String()),  // default "azure-foundry"
  investigatorModel: Type.Optional(Type.String()),     // default "Kimi-K2.6"
  pythonPath: Type.Optional(Type.String()),
  agentkbPythonPath: Type.Optional(Type.String()),
  agentkbCwd: Type.Optional(Type.String()),
  restrictReadRoot: Type.Optional(Type.String()),
}
```

(`maxDepth` joins in Phase 5; `analystModel` in Phase 4.)

Description: "Answer a question by iterative Python-REPL investigation over the local
knowledge base (RLM). Use for deep KB research questions; keeps noisy search/read work
out of the main context."

### Execute flow

1. **Resolve model** via `ctx.modelRegistry.find(provider, modelId)`. `undefined` →
   return `isError`-style failure text naming the missing `provider/model` and pointing
   at `~/.pi/agent/models.json`. Then `getApiKeyAndHeaders(model)`; `!ok` → surface
   `auth.error`.
2. **Initial context**: `kbSearch(agentkbOptions, prompt, k, scope)` from TypeScript
   (same code path the RPC handler uses). On failure (agentkb missing — e.g. the
   private dev machine — or non-zero exit): `context = []`, keep the capped error as
   `contextNote`. The investigation still runs; the model is told the initial search
   failed and may retry `kb_search` itself or answer from reasoning alone.
3. **Spawn REPL**: `new PythonRepl({ pythonPath, signal })`, `setRpcHandlers(createRpcHandlers(...))`,
   `await repl.ready()`, `await repl.setVar("context", contextHits)`.
4. **Run**: `runInvestigation({...})` with `onEvent` forwarding to `onUpdate` (turn
   number + capped text so the Pi UI shows live progress).
5. **Return**:
   ```typescript
   {
     content: [{ type: "text", text: answer }],
     details: { stopReason, turns, costUsd, contextHits: contextHits.length },
   }
   ```
   For `stopReason: "error"`, prefix the answer with a clear error line.
6. **`finally`**: `await repl.close()`.

No custom `renderCall`/`renderResult` yet (Phase 6); default rendering is fine.

---

## 3. Testing Plan — `test-phase3.ts`

Same style as `test-phase2.ts`: standalone script, real `PythonRepl` + mock RPC
handlers + **scripted fake `completeFn`** (returns canned `AssistantMessage`s in
sequence; build a small `fakeAssistant(text, costUsd)` helper that fills in required
fields: `usage`, `stopReason: "stop"`, `timestamp`, `api/provider/model`).

Honor `RLM_PYTHON` env override exactly like the Phase 1/2 scripts (private machine
has no agentkb venv).

### Host-level tests (exec direct)

1. `_RLM_HOST_PHASE == 3`; `_RLM_BUILTINS` contains the five builtins.
2. `FINAL("done")` → result `final == "done"`, `error == null`, code after `FINAL` does
   **not** run (set a variable after the call, check next turn it is undefined).
3. `FINAL` with a dict → `final` is its JSON serialization.
4. `FINAL_VAR("x")` after `x = "answer"` → `final == "answer"`; `FINAL_VAR("missing")`
   → traceback contains `NameError`.
5. `FINAL` inside `try/except Exception` → still ends the block (sentinel is a
   `BaseException`).
6. `SHOW_VARS()` lists a user variable, excludes `kb_search` and `_RLM_BUILTINS`.
7. Stale-final reset: block 1 calls `FINAL`, block 2 (fresh exec, same REPL would have
   ended — test via a second exec anyway) returns `final == null`.
8. `setVar("context", [...])` → Python sees a real list of dicts; non-ASCII values
   survive the round trip.

### Loop-level tests (fake `completeFn`)

9. Happy path: scripted turn 1 writes code printing from `context`, turn 2 calls
   `FINAL("the answer")` → result `{ answer: "the answer", stopReason: "final", turns: 2 }`.
10. No code block: scripted reply is prose only → `stopReason: "no_code"`, answer is
    the prose.
11. Error recovery: turn 1 code raises `ZeroDivisionError` → the observation passed
    into the turn 2 fake contains the traceback; turn 2 finishes with `FINAL`.
12. `max_turns`: fake always returns code without `FINAL` → `stopReason: "max_turns"`,
    answer carries the stop note, turns == maxTurns.
13. Budget: fake reports `costUsd: 0.30` per call, `maxBudgetUsd: 0.50` → stops after
    turn 2 with `stopReason: "budget"`.
14. Output capping: code prints 100 000 chars → observation message length ≤ cap +
    marker, contains both head and tail content.
15. Last-block extraction: assistant text with two fenced blocks → only the second
    executes.
16. `completeFn` returns `stopReason: "error"` → investigation returns
    `stopReason: "error"` with `errorMessage` included.
17. Abort: `AbortController` fired between turns → `stopReason: "aborted"`, REPL is
    closed, no unhandled rejection.
18. Events: `onEvent` saw `turn_start` / `assistant_text` / `code_block` /
    `exec_result` in order for the happy path.

### Manual / integration

- **Private machine**: `RLM_PYTHON=<python> node .pi/extensions/rlm/test-phase3.ts`
  (all of the above; no agentkb, no API keys needed).
- **Pi end-to-end (corporate machine)**: load the extension, ask something like
  `rlm_query("How is the Azure proxy configured according to the wiki?")` and verify:
  initial context populated, ≥1 investigator turn with `kb_search`/`kb_read` visible
  in onUpdate output, `FINAL` answer returned, `details.costUsd > 0`, REPL process
  gone afterwards, Esc aborts cleanly mid-run.
- **Pi end-to-end (private machine)**: same but expect `context = []` + contextNote
  path; use whatever configured model `ctx.modelRegistry` can resolve (override via
  `investigatorProvider`/`investigatorModel` params).

---

## 4. Edge Cases

| Edge case | Handling |
|---|---|
| `FINAL()` then more code in the block | Sentinel exception stops the block; remaining code never runs. |
| `FINAL()` swallowed by `except BaseException:` | Value already stored; host still reports `final`; remaining code may run (accepted). |
| `final` and `error` both set | `final` wins; investigator ignores the error. |
| Non-string `FINAL` argument | JSON-serialized, `str()` fallback. |
| Assistant reply with no code block | Investigation ends; prose is the answer (`no_code`). |
| Empty/unterminated code fence | Same as no code block. |
| Two code blocks in one reply | Only the last executes. |
| Initial `kb_search` fails (no agentkb) | `context = []`, prompt carries the failure note, run continues. |
| Model not found in registry | Clear error naming `provider/model` and `models.json`; no REPL spawned. |
| Auth resolution fails | Surface `auth.error` from `getApiKeyAndHeaders`. |
| `complete()` resolves with `stopReason: "error"` | Loop returns `stopReason: "error"` + `errorMessage`; no retry in Phase 3. |
| Budget exceeded mid-run | Stop before the next `complete()`; best-effort answer. |
| Exec timeout / REPL crash mid-run | Exec rejects → `stopReason: "error"` with diagnostics; `finally` close is a no-op on the dead process. |
| Esc during a model call | `signal` → in-band `"aborted"`. |
| Esc during an exec | `signal` → `PythonRepl.fail()` kills the subprocess; loop maps the rejection to `"aborted"`. |
| Huge stdout | Head+tail capping with omission marker. |
| `set_var` with invalid name | Result envelope with `error`; `setVar()` rejects. |

---

## 5. Build Order

1. `host.py`: `_RlmFinal` + `FINAL` / `FINAL_VAR` / `SHOW_VARS`, per-exec final reset,
   `set_var` handling, markers → verify by piping JSON lines manually.
2. `repl.ts`: extract `sendRequest()` helper, add `setVar()`.
3. `prompt.ts`: `buildSystemPrompt()`.
4. `investigator.ts`: loop with injectable `completeFn`.
5. `test-phase3.ts`: host-level tests first, then loop-level; iterate until green
   (run with `RLM_PYTHON` override on the private machine).
6. `index.ts`: rewrite as the real tool; wire model resolution, initial context,
   onUpdate streaming.
7. Manual Pi test (tmux per CLAUDE.md), then `npm run check` (expect only the
   pre-existing unrelated failures noted in PHASE2-NOTES; the `.pi/` tree itself is
   outside the root tsconfig/biome includes — re-use the temporary-config check
   approach from Phase 2).

---

## 6. Completion Criteria

1. All `test-phase3.ts` tests pass on the private machine (`RLM_PYTHON` override).
2. `FINAL` / `FINAL_VAR` / `SHOW_VARS` behave per Section 4's edge-case table.
3. `rlm_query` in Pi answers a real question end-to-end on the corporate machine:
   context preloaded, multi-turn loop, `FINAL` answer, cost and turns in `details`.
4. Graceful degradation without agentkb (empty context + note) verified on the
   private machine.
5. Esc aborts a running investigation without orphan Python processes or unhandled
   rejections.
6. Type-check and lint clean for the extension files (temporary-config approach);
   no new `npm run check` regressions.
