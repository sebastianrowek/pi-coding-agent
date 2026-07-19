# RLM Extension — Open Items

Status as of 2026-06-12: phases 1-6 (the locked v1 scope per PLAN.md) are
implemented; all 104 tests across the six suites pass on the private machine
(`RLM_PYTHON=C:\Users\User\miniconda3\python.exe`: 21 + 13 + 20 + 18 + 17 + 15).
Everything below is what remains before the implementation can be called fully
verified.

## Corporate-machine verification (blocking)

Every green test uses mock RPC handlers and fake `completeFn`s; the live path
has never been exercised. The private machine has no agentkb install and no
Azure Foundry access, so these must run on the corporate machine:

1. **End-to-end run with real models and real KB.** Ask `rlm_query` a question
   that decomposes into sub-questions. Verify:
   - preloaded `context`, multi-turn loop with `kb_search`/`kb_read` visible in
     the rendered timeline, `FINAL` answer;
   - both models resolve (`azure-foundry/Kimi-K2.6` investigator,
     `azure-foundry/gpt-5.4-nano` analyst) and are billed
     (`details.costUsd > 0`, `details.modelCalls > details.turns`);
   - nested markers in the timeline, `details.nestedRuns >= 1`, depth-2
     `rlm_query` downgrades silently;
   - `details.runId`/`logPath` set; the NDJSON file exists, every line parses
     (`jq -c . <file> > /dev/null`), `run_start`/`run_end` bracket the run,
     child events carry `root.N` ids, `rpc` events show durations;
   - model calls succeed through the TLS-intercepting proxy. The extension
     calls `complete()` in-process and relies on pi's global SSL handling
     (`disableSslVerification`) — assumed, never verified; a TLS error here
     means that inheritance assumption failed. agentkb's CLI is independent
     (its own `ssl_compat`).
2. **Abort path.** Esc mid-run (ideally mid-nested-tree) writes `run_end` with
   `stopReason: "aborted"` and kills every Python process (check Task Manager).
3. **agentkb integration suite.** `RLM_AGENTKB_TESTS=1` rerun of
   `test-phase2-agentkb.ts` — also confirms the real agentkb CLI accepts the
   `--` separator before the query (assumed argparse-style, never verified).
4. **tmux TUI verification** (no tmux on the private machine): run
   `./pi-test.sh`, issue an `rlm_query`, capture (a) the running partial view,
   (b) the collapsed result, (c) the Ctrl+O expanded timeline + answer + log
   footer; verify the system prompt lists the `promptSnippet` and the three
   guideline bullets.

## Deferred by design (not blocking)

- **Jupyter export** (PLAN.md phase 7): NDJSON-to-`.ipynb` converter with a
  bootstrap cell. Out of v1 per locked decision 5; the NDJSON log is the
  replay source when this gets picked up.

## Known environment issues (not part of this feature)

- `.pi/` is excluded from the repo's root `biome.json` and tsconfig include
  set; type-check and lint for this extension run via temporary configs (see
  PHASE6-NOTES.md "Verification status").

## Minor doc drift

- PLAN.md's file list includes a `package.json` for the extension that was
  never created — intentional, no extra runtime deps were needed (typebox is
  provided by the extension host).
