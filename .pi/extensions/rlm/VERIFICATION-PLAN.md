# RLM Extension — Corporate Machine Verification Plan

Date: 2026-06-23
Corresponds to: `OPEN-ITEMS.md` (status as of 2026-06-12)

## Context

Phases 1–6 are implemented; all 104 mock tests pass on the private machine. This plan executes every remaining verification item from `OPEN-ITEMS.md` on the corporate machine (where the agentkb install, Azure Foundry access, and the actual pi runtime all live).

## Machine State (verified before execution)

- `azure-foundry` provider configured in `~/.pi/agent/models.json` with:
  - `Kimi-K2.6` (investigator)
  - `gpt-5.4-nano` (analyst)
  - `api: "openai-completions"`, `supportsReasoningEffort: false`
- agentkb venv present and functional:
  - `/c/Appl/workspace/Python/agentkb/venv/Scripts/python.exe`
  - `py -m agentkb search --json` returns real KB hits
- `rlm_query` already registered by `./pi-test.sh` (visible in tool list)
- No `tmux` / no `jq` — workarounds documented below
- `.pi/` excluded from root `tsconfig.json` and `biome.json` — temporary tsconfig required for tests

---

## Phase A — Baseline Infrastructure

1. Create `tsconfig.rlm.json` extending the root config, adding `.pi/extensions/rlm/*.ts` to `include`.
2. Run `npx tsgo --project tsconfig.rlm.json --noEmit` to type-check the extension on this machine.

---

## Phase B — Mock Regression Tests

Run all six suites via tsx with the venv Python. Expected: **104/104 pass**.

```bash
export RLM_PYTHON="/c/Appl/workspace/Python/agentkb/venv/Scripts/python.exe"

npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase1.ts  # 21 tests
npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase2.ts  # 13 tests
npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase3.ts  # 20 tests
npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase4.ts  # 18 tests
npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase5.ts  # 17 tests
npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase6.ts  # 15 tests
```

**Acceptance:** Every suite exits with code 0.

---

## Phase C — Real agentkb Integration

Run the gated suite against live agentkb CLI.

```bash
export RLM_AGENTKB_TESTS=1
export RLM_PYTHON="/c/Appl/workspace/Python/agentkb/venv/Scripts/python.exe"

npx tsx --tsconfig tsconfig.rlm.json .pi/extensions/rlm/test-phase2-agentkb.ts
```

**Verify:**
- All 7 tests pass.
- `kb_search` round-trip works (confirms `--` separator accepted by argparse-style CLI).
- `kb_read` returns real file contents.
- No mock handlers involved.

---

## Phase D — End-to-End with Real Models + Real KB

Use `./pi-test.sh` in non-interactive (`-p`) mode with a question that forces decomposition.

```bash
./pi-test.sh -p \
  "Using rlm_query, compare what the wiki says about extensions versus themes in this project." \
  --no-session
```

**Verification checklist:**
- [ ] Preloaded `context` from initial KB search appears in the timeline.
- [ ] Multi-turn loop visible; `kb_search` / `kb_read` calls present in the streamed timeline.
- [ ] `FINAL()` answer returned in `content`.
- [ ] `details.costUsd > 0` (real model billing happened).
- [ ] `details.modelCalls > details.turns` (analyst/nested calls fired).
- [ ] `details.nestedRuns >= 1` (recursion tree spawned).
- [ ] Depth-2 `rlm_query` downgrades silently (no error; returns answer via analyst).
- [ ] `details.runId` and `details.logPath` are set.

---

## Phase E — Abort Path

Because `./pi-test.sh -p` is non-interactive (sends prompt in one shot), abort must be tested either:

- **Option 1:** Run `./pi-test.sh` interactively in a separate terminal and press Esc mid-run.
- **Option 2:** Issue a prompt wrapped in a short external timeout that kills the Node process.

**Verification checklist:**
- [ ] NDJSON log contains `run_end` with `stopReason: "aborted"`.
- [ ] No orphaned `python.exe` processes remain (`tasklist | grep python` or Task Manager).
- [ ] Parent and any nested child REPLs are both terminated.

---

## Phase F — Log Verification

After the end-to-end run, inspect the generated NDJSON log.

```bash
# Most recent log file
LOG=$(ls -t ~/.pi/rlm-logs/*.ndjson | head -1)

# Validate every line parses as JSON (no jq on this machine)
node -e "
require('fs').createReadStream(process.argv[1], 'utf8')
  .on('data', c => c.split('\n').forEach(l => {
    if (!l) return;
    try { JSON.parse(l); }
    catch (e) { console.error('BAD LINE:', l.slice(0, 200)); process.exit(1); }
  }))
  .on('end', () => console.log('All lines valid JSON'));
" "$LOG"
```

**Verify:**
- [ ] First event is `run_start`; last event is `run_end`.
- [ ] Child/nested events carry `root.N` ids (not just `root`).
- [ ] `rpc` events include `durationMs`.
- [ ] `nested_start` / `nested_end` events bracket child runs.
- [ ] `downgrade` event appears when depth limit triggers.
- [ ] Every line is valid NDJSON.

---

## Phase G — TUI Rendering

No `tmux` available. Run `./pi-test.sh` **interactively**, issue an `rlm_query`, and observe the three UI states manually.

1. **Partial (running):**
   - Header: `⏳ investigating…` + `turn N · C calls · M nested`.
   - Last `PARTIAL_TIMELINE_TAIL_ENTRIES` (8) timeline entries visible.

2. **Collapsed (finished):**
   - Status icon by `stopReason`:
     - `final` → `✓`
     - `no_code` / `max_turns` / `budget` → `◐`
     - `error` / `aborted` → `✗`
   - `formatRunStats` line (turns, calls, cost, nested, ctx hits).
   - First `COLLAPSED_ANSWER_LINES` (10) of answer.
   - Footer: `(Ctrl+O to expand)`.

3. **Expanded (Ctrl+O):**
   - `─── Investigation ───` header.
   - Full timeline with nested markers indented by `depth`.
   - `─── Answer ───` rendered as Markdown.
   - Dim footer: `run <id> · log: <path>`.

4. **Prompt Surface:**
   - Verify the main agent system prompt lists:
     - `promptSnippet`: `Multi-source KB/wiki and aggregate analysis via an isolated REPL investigation`
     - Three `promptGuidelines` bullets (use case, self-contained question, budget warning).

**Acceptance:** All four render states display correctly in the terminal.

---

## After All Phases Pass

1. Delete temporary `tsconfig.rlm.json`.
2. Update `OPEN-ITEMS.md`: mark verified items as done, remove this plan file reference if desired.
3. The extension is then considered fully verified for the v1 scope.

## Known Environment Notes (not blocking)

- Extension type-check/lint is done via temporary configs because `.pi/` is excluded from the repo root `tsconfig.json` and `biome.json`.
- `PLAN.md` mentions a `package.json` that was never created — this is intentional (no extra runtime deps; typebox is provided by the host).
- Jupyter export (phase 7) remains deferred per locked decision 5.
