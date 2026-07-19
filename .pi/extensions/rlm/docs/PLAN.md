# RLM Extension Implementation Plan

Port of Isaac Flath's RLM tool (https://isaacflath.com/writing/rlm) to this repo as a
project-local Pi extension, backed by the local `agentkb` install at
`C:\Appl\workspace\Python\agentkb`.

## What an RLM is (recap)

An LLM (the *investigator*) answers a question by repeatedly writing Python into a
persistent REPL. The REPL namespace is preloaded with `context` (KB search hits) and a
set of builtins (`kb_search`, `kb_read`, `llm_query`, `rlm_query`, `FINAL`, ...). Each
turn: the extension calls the investigator model with the running chat history, extracts
the fenced Python block, runs it in the live REPL namespace, captures stdout/stderr,
appends the result as the next "user" message, and loops until `FINAL()` is called, the
model stops writing code, turns run out, or budget is exhausted. Recursion: `rlm_query`
starts a fresh nested investigation (new REPL, new context, shared budget).

This is the "code-as-tool-call" shape: a Python REPL instead of bash, builtins instead of
binaries, persistent namespace across turns, with the noisy search/read/fan-out work
isolated in a child process + child model so it never pollutes the main agent context.

## Architecture (three pieces)

```
Pi agent
  └─ rlm_query tool (TS extension)        <-- registered via pi.registerTool
        ├─ investigator loop (complete() calls to the smart model)
        ├─ RPC server for builtins (kb_search / llm_query / rlm_query ...)
        └─ Python REPL subprocess (one per rlm_query call)
              ├─ persistent namespace dict (lives for the whole run)
              ├─ exec(code) of each turn's block
              └─ builtin shims that round-trip to the extension via RPC
```

### IPC: two logical channels, multiplexed over stdin/stdout

The article uses pipes with two channels:
1. Big "run this code block / here is the result" exchanges.
2. Small "I need X" RPC requests the Python builtins make *mid-block*.

Implementation: newline-delimited JSON over the subprocess's stdin/stdout (faithful to
"pipes, not TCP"; works on Windows where extra FDs are awkward). Message envelope on
stdout:
- `{ "type": "rpc", "id": N, "method": "kb_search", "args": {...} }`  (Python -> ext, mid-block)
- `{ "type": "result", "stdout": "...", "stderr": "...", "final": ..., "error": ... }` (block done)
- `{ "type": "ready" }` (host booted)

Extension -> Python on stdin:
- `{ "type": "exec", "code": "..." }`
- `{ "type": "rpc_response", "id": N, "ok": true, "value": ... }` / `{ "ok": false, "error": "..." }`

Python side runs `exec(code, namespace)` on the main thread; builtins write an `rpc`
line and block-read stdin until the matching `rpc_response` arrives. Because exec is
synchronous and the extension only sends one `exec` at a time, interleaving an RPC
request inside a running block is safe. stdout from user `print()` is captured (redirect
`sys.stdout`) and returned in the final `result`, not streamed raw, so it never collides
with the JSON envelope.

## Files

```
.pi/extensions/rlm/
  PLAN.md            (this file)
  index.ts           entry point: registerTool("rlm_query"), config, renderCall/renderResult
  investigator.ts    the turn loop: build prompt, complete(), extract code, drive REPL, budget
  repl.ts            spawn/manage Python host, exec(code) -> result, RPC dispatch
  rpc.ts             builtin handlers: kb_search, kb_read, llm_query(+batched), rlm_query(+batched)
  agentkb.ts         shell out to `py -m agentkb` (search --json, read via path)
  prompt.ts          system prompt describing the REPL, context var, and builtins
  budget.ts          shared budget/cost tracker across the recursion tree
  logging.ts         NDJSON event logger (one line per event) + run id
  host.py            Python REPL host (read-eval loop, namespace, builtin shims)
  package.json       deps (typebox is provided; no extra runtime deps needed)
```

## REPL namespace contract

Preloaded variable:
- `context`: list of dicts `{path, score, snippet/title, ...}` from the initial `kb_search`
  for the user's question. Described in the system prompt as the starting point.

Builtins (Python shims that RPC to the extension unless noted):
| builtin | behavior |
|---|---|
| `kb_search(query, k=5, scope='wiki')` | RPC -> `py -m agentkb search --json -k k -s scope query`; returns list of hit dicts |
| `kb_read(path)` | RPC -> read full file text at `path` (absolute path from a hit) |
| `llm_query(prompt)` | RPC -> `complete(analystModel, ...)`; string in, string out; budget-tracked |
| `llm_query_batched(prompts)` | RPC -> concurrent `complete()` (cap 16) |
| `rlm_query(prompt, context=None)` | RPC -> nested investigation (new REPL); downgrades to `llm_query` at recursion limit; shared budget |
| `rlm_query_batched(prompts, contexts=None)` | RPC -> concurrent nested investigations (cap 4) |
| `FINAL(answer)` | set final answer string, end the loop |
| `FINAL_VAR(name)` | end with the value of namespace variable `name` |
| `SHOW_VARS()` | return a summary of namespace contents |
| stdlib | full Python stdlib available in the namespace |

Chunking helper (from the article) for over-long pages can be a stdlib-only helper
preinstalled in the namespace or documented in the prompt.

## Investigator loop (investigator.ts)

1. Build initial chat history: system prompt (prompt.ts) + user message = the question.
   Run the initial `kb_search(question)` to populate `context`; describe it in the prompt.
2. Loop up to `maxTurns`:
   a. `complete(model, { systemPrompt, messages }, { apiKey, headers, signal, reasoningEffort })`.
   b. Log assistant prose. Extract the last fenced ```python block. If none -> end loop.
   c. `repl.exec(code)`; during exec, dispatch RPC builtin calls (rpc.ts).
   d. Append `{ role: "user", content: stdout+stderr (capped) }` to history; log it.
   e. If `final` was set -> return it. If budget exhausted -> end with best-effort answer.
3. Return `{ answer, reason, cost, turns }`.

Model selection (configurable, defaults below):
- Investigator (depth 0): `azure-foundry/Kimi-K2.6`.
- Analyst (`llm_query`, depth >= 1 `rlm_query`): `azure-foundry/gpt-5.4-nano`.

`azure-foundry` is the user's custom OpenAI-compatible provider declared in
`~/.pi/agent/models.json` (baseUrl `https://pi-agent-models.services.ai.azure.com/openai/v1`,
inline apiKey, `api: "openai-completions"`). Resolve these through the **runtime model
registry**, NOT the static `getModel()` from pi-ai (which only knows built-in providers):

```ts
const model = ctx.modelRegistry.find("azure-foundry", "Kimi-K2.6"); // Model<Api> | undefined
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);   // { ok, apiKey, headers, error }
await complete(model, { systemPrompt, messages }, { apiKey: auth.apiKey, headers: auth.headers, signal });
```

The `Model` object returned by `find()` carries `baseUrl`, so the `openai-completions`
provider targets the Azure Foundry endpoint automatically. `azure-foundry` sets
`compat.supportsReasoningEffort: false` and `supportsDeveloperRole: false` -> do NOT pass
`reasoningEffort`, and keep the system prompt as a `system` role (the provider downgrades
as needed). Make provider/model ids overridable via tool params, defaulting to the two
above; if `find()` returns undefined, surface a clear error naming the missing model.

## Budget and recursion (budget.ts)

- A `max_budget` (USD) shared across the whole tree and parallel siblings; each `complete()`
  adds `usage.cost.total`. Children get whatever the parent has left.
- `maxDepth` (default 1-2). At the limit, `rlm_query` downgrades to `llm_query`.
- Concurrency caps: `llm_query_batched` 16, `rlm_query_batched` 4 (mapWithConcurrencyLimit
  helper as in subagent example).
- Respect `ctx.signal` (Esc) -> pass to `complete()` and kill the Python subprocess.

## agentkb integration (agentkb.ts) - environment specifics

Per `agentkb/AGENTS.md`, this is a restricted corporate machine:
- Never call the bare `agentkb` executable. Invoke `py -m agentkb ...` using the venv at
  `C:\Appl\workspace\Python\agentkb\.venv` (or `venv`). Make the python/venv path and the
  agentkb cwd configurable (settings/flags), defaulting to that location.
- `kb_search`: `py -m agentkb search --json -k <k> -s <scope> "<query>"` -> parse
  `{results:[{path, file, filename, score, title?, section?, tags?}]}`. Map to hit dicts.
- `kb_read`: hits carry absolute `path`/`file`; read the file directly (Node fs) rather
  than a CLI call, OR add a thin read path. Simplest: fs.readFile(path).
- SSL: agentkb's CLI already imports `ssl_compat`; no extra handling needed for CLI calls.
- Run agentkb calls from the extension (one implementation + central logging), matching
  the article's RPC rationale.

## Logging (logging.ts) + Jupyter export (optional, phase 2)

- Write one NDJSON line per event (turn_start, assistant_prose, code_block, stdout,
  rpc_call, final) to `<logdir>/<runid>.ndjson`.
- Phase 2: a converter that turns the NDJSON into a live `.ipynb` (bootstrap cell that
  launches the host and installs the same shims, preloads `context`). Defer until the
  core loop works.

## Tool surface

`pi.registerTool({ name: "rlm_query", ... })`:
- params (typebox): `prompt: string`, optional `scope`, `k`, `maxTurns`, `maxDepth`,
  `maxBudget`, `investigatorModel`, `analystModel`.
- `execute()` runs the investigator loop, `onUpdate` streams turn-by-turn prose/code,
  returns `{ content:[{type:"text", text: answer}], details: { turns, cost, runId, logPath } }`.
- `renderCall` / `renderResult`: collapsed = answer + cost/turns; expanded = per-turn
  prose + code + output timeline (reuse subagent's rendering patterns).
- `promptSnippet` / `promptGuidelines`: tell the main agent to use `rlm_query` for
  deep KB research questions so noise stays out of the main context.

## Key API references (verified in repo)

- Model call: `complete(model, { systemPrompt, messages }, { apiKey, headers, signal, maxTokens, reasoningEffort })`
  from `@earendil-works/pi-ai`. `StreamOptions` has `signal`, `maxTokens`; `Context` has
  `systemPrompt`, `messages`. (`packages/ai/src/stream.ts`, `types.ts`.)
- Auth: `ctx.modelRegistry.getApiKeyAndHeaders(model)` -> `{ ok, apiKey, headers, error }`.
- Model lookup: `getModel(provider, id)`; defaults must be ids present in models.generated.ts.
- Subprocess + streaming JSON lines + concurrency cap + rich rendering patterns:
  `examples/extensions/subagent/index.ts`.
- Tool registration, `onUpdate`, `renderCall/renderResult`, abort via `signal`:
  `docs/extensions.md` Custom Tools section.

## Build order (phases)

1. Python `host.py` + `repl.ts`: spawn, exec a block, capture stdout, return result. No RPC.
2. RPC channel + `kb_search`/`kb_read` builtins via agentkb. Manual single-turn test.
3. Investigator loop + system prompt + `FINAL` + `complete()` calls. End-to-end one query.
4. `llm_query` (+batched), budget tracker, model split (investigator/analyst).
5. `rlm_query` (+batched) recursion with depth limit + shared budget.
6. NDJSON logging; `renderCall/renderResult`; `promptSnippet`/guidelines.
7. (Optional) Jupyter export.

## Decisions (locked)

1. Investigator default `azure-foundry/Kimi-K2.6`; analyst default `azure-foundry/gpt-5.4-nano`.
   Resolved via `ctx.modelRegistry.find()`. No `reasoningEffort` (compat disables it).
2. Logs: global `~/.pi/rlm-logs/<runid>.ndjson`.
3. Defaults: `maxTurns=12`, `maxDepth=2`, `maxBudget=$0.50` (USD, shared across the tree).
4. agentkb: invoke via the venv at `C:\Appl\workspace\Python\agentkb\venv`
   (i.e. `venv\Scripts\python.exe -m agentkb ...`, never the global exe). Default search
   scope `wiki`, configurable per call.
5. v1 = phases 1-6 (live loop, recursion, budget, logging, rendering). Jupyter export deferred.
```
