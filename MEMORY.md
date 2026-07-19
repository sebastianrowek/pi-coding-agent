# Project Memory

## Project Overview
pi-coding-agent monorepo: packages/ai (LLM providers), packages/tui (terminal UI), packages/coding-agent (main agent).

## Key Architecture / Decisions
- `AuthStorage.getApiKey` supports `skipInteractiveRefresh` option to prevent background tasks from triggering interactive OAuth refresh dialogs.
- `ModelRegistry.getApiKeyAndHeaders` passes that option through.
- `.pi/extensions/status-footer.ts` uses `{ skipInteractiveRefresh: true }` for its fast progress model lookups.

## Current State
- Pre-existing: `packages/ai/test/` has type errors (model name literals vs generated types) unrelated to this fix.

## Notes / Gotchas
- `npm run check` errors in `packages/ai/test/` are pre-existing model name type mismatches.
- The `FAST_PROGRESS_MODELS` list in status-footer.ts includes openai-codex and anthropic models. If a user has expired OAuth for any of those, background progress jobs would previously trigger the interactive dialog.
- `LoginDialogComponent` cancel works (Escape rejects the showPrompt promise, finally block clears dialog), but the status footer loop hits multiple anthropic candidates sequentially, making it reappear instantly after cancel.

## Open Questions
- Should `FAST_PROGRESS_MODELS` include `azure-foundry` or the user's active model as a candidate?
