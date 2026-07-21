# Minimal Subagents

A pi extension that registers a single `subagent` tool with three agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls | claude-haiku-4-5 | Fast codebase recon |
| **researcher** | web_search, web_fetch | claude-sonnet-4-6 | Web research |
| **worker** | read, write, edit, safe_bash | claude-sonnet-4-6 | Code changes |

## Usage

**Single mode:**
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

**Parallel mode:**
```json
{ "tasks": [
  { "agent": "scout", "task": "Map the database layer" },
  { "agent": "researcher", "task": "Best practices for connection pooling" }
]}
```

Max 4 concurrent subagents (configurable). Each runs as an isolated `pi` process with no inherited context — all context must be in the task description.

## Subagent Sessions & Traces

Subagent child processes persist standard session files to a dedicated
`__subagents__/` directory under the global sessions folder
(`~/.pi/agent/sessions/__subagents__/`). Each child session links back to its
parent session via the `parentSession` header field.

The extension also writes a `subagent_trace` custom entry into the parent
session, containing rolled-up usage totals and a per-child breakdown:

```jsonc
{
  "version": 1,
  "mode": "single" | "parallel",
  "parentSessionId": "<uuid>",
  "children": [
    {
      "agent": "scout",
      "sessionId": "<child-uuid>",
      "model": "claude-haiku-4-5",
      "exitCode": 0,
      "usage": { "input": 1234, "output": 567, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0012, "turns": 3 }
    }
  ],
  "totals": { "input": 1234, "output": 567, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0012, "turns": 3 }
}
```

### Discovery

Child sessions in `__subagents__/` are excluded from per-project `--resume` but
visible to `SessionManager.listAll()` and external session-scanning tools
(e.g., agentsview). The `subagent_trace` entry provides cheap totals without
reading child session files.

When the parent session is ephemeral (`--no-session`), child sessions are also
ephemeral — nothing is persisted.

### TTL Sweeper

Old child sessions are automatically cleaned up on extension startup.
Default TTL is 60 days. Override with the `PI_SUBAGENT_SESSION_TTL_DAYS`
environment variable.

Parent aggregates survive child deletion, so cost history is preserved.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## UI

Default view shows medium detail (agent status, task preview, recent tools). Expand to see full task, all tool calls, complete output, and token usage.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension)
- **model** — model identifier (defaults to `anthropic/claude-sonnet-4-6`)

The markdown body becomes the agent's system prompt.

### 2. Register agents via `globalThis.__pi_subagents`

Pi loads extensions via jiti, which creates separate module instances. Direct imports from the subagents extension will reference a different `agents` array than the one the `subagent` tool uses. Use the `globalThis` bridge instead:

```typescript
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  systemPrompt: string;
  filePath: string;
}

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
        systemPrompt: body,
        filePath,
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_search: path.join(EXT_BASE, "web-search", "index.ts"),
  web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
  video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
  youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
  google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts`.

## Structure

```
subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
└── tools/             # Extensions loaded into subagent processes
    └── safe-bash.ts   # bash with dangerous command blocking
```
