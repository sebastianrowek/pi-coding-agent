<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

## Fork: Corporate Laptop Setup

This is a personal fork of [earendil-works/pi](https://github.com/earendil-works/pi) adapted for use on a company laptop behind a **TLS-intercepting corporate proxy** (self-signed certificate).

### Changes from upstream

#### Core modifications
- **Resource settings (`extensions`/`skills`/`prompts`/`themes`)** — Pi discovers resources from the corresponding arrays in `settings.json`. The Docker script temporarily overlays these arrays with the mounted `/pi-resources/<type>` directories so repo-committed resources are available inside the container without modifying your global settings.
- **Corporate certificate handling** — TO BE FILLED


#### Extensions (`.pi/extensions/`)

| Extension | Description |
|-----------|-------------|
| **rlm** | Research via iterative Python-REPL investigation. Spawns an investigator loop with `kb_search`/`kb_read` builtins, analyst LLM delegation, recursion, and NDJSON run logging. Exposed as `rlm_query` tool. |
| **web-fetch** | Fetch URLs and extract readable content as markdown (Readability + Turndown, PDF support, Jina Reader fallback). |
| **memory** | Persistent memory store across sessions. |
| **bash-guard (deactivated)** | Safety layer for bash command execution. |
| **ask-user-question (deactivated)** | Tool for the agent to ask clarifying questions mid-turn. |
| **status-footer** | Status bar showing session info. |
| **tps** | Tokens-per-second display. |
| **redraws** | TUI redraw helpers. |
| **prompt-url-widget** | URL display in prompt area. |

#### Skills (`.pi/skills/`)

| Skill | Description |
|-------|-------------|
| **pdf-reader** | Read and comprehend PDF files (math lecture notes, academic papers). |
| **readme-generator** | Generate accurate READMEs from actual code; handles monorepos. |
| **high-signal-chart-workflow** | Data story to publication-quality chart via parallel variants and design verification. |
| **add-llm-provider** | Checklist for adding a new LLM provider to `packages/ai`. |

### Installation (Windows, company laptop)

**Prerequisites:**

1. [Git for Windows](https://git-scm.com/download/win) (provides Git Bash, required by pi)
2. Node.js >= 22. Make sure to use the version:
   ```powershell
   nvm use 22
   ```

**Clone, build, and run:**
Its necessary to configure Node.js to trust your corporate TLS proxy by exporting the root certificate (e.g. from Edge) and setting:

```powershell
$env:NODE_EXTRA_CA_CERTS="C:\Appl\workspace\certificates\trusted_certs.crt"
```

Then run the same commands without disabling TLS:

```powershell
git clone https://github.com/sebastianrowek/pi-coding-agent.git
cd pi-coding-agent

npm install --ignore-scripts
npm run build

node packages/coding-agent/dist/cli.js
```

This approach preserves TLS verification while adding trust for the corporate proxy.

### Docker (containerized execution)

For environment isolation, pi can run entirely inside a Docker container. The container installs dependencies and builds from source — no Node.js needed on the host.

**Clone the repo:**

```powershell
git clone https://github.com/sebastianrowek/pi-coding-agent.git
cd pi-coding-agent
```

**Build:**

```powershell
# Build the image (installs deps + builds dist inside the container).
# --build-context certs=... tells Docker where to find trusted_certs.crt
# without copying it into the repo.
docker build -t pi-local -f Dockerfile.local `
  --build-context certs=C:\Appl\workspace\certificates `
  .
```

OR

```powershell
.\docker-build.ps1
```

**Run:**

```powershell
.\docker-run.ps1
```

This mounts the current directory as `/workspace` (the only files pi can touch) and `~/.pi/agent` for config/sessions. The corporate cert is baked into the image's system CA store so Azure calls work without runtime env vars.
When launched outside this repository, the `.\docker-run.ps1` script creates a temporary overlay of `~/.pi/agent/settings.json` that appends `/pi-resources/extensions`, `/pi-resources/skills`, `/pi-resources/prompts`, and `/pi-resources/themes` to the existing `extensions`, `skills`, `prompts`, and `themes` arrays. When launched from this repository, Pi discovers the same resources from `/workspace/.pi` instead, avoiding duplicate extension loads. The repo's `.pi` folder is mounted read-only at `/pi-resources`, so the container can discover the committed resources without altering host settings.

After source changes, rebuild and re-run:

```powershell
docker build -t pi-local -f Dockerfile.local `
  --build-context certs=C:\Appl\workspace\certificates `
  .
.\docker-run.ps1
```
See [the Pi agent Docker documentation](https://github.com/sebastianrowek/wiki/blob/c45d06d80c737ad1999ca2d85e39117df35724ce/wiki/pi-agent/pi-agent-with-docker.md) for full details on the Dockerfile layers, caching, and volume mounts.

### Persistent Instructions (AGENTS.md)

Pi injects an `AGENTS.md` file into the system prompt automatically — this is the equivalent of Claude Code's `CLAUDE.md`. Place one in your project root for project-specific instructions, or at `~/.pi/agent/AGENTS.md` for global instructions that apply to every session. Pi walks up the directory tree from the current working directory to find the file. `CLAUDE.md` is also recognized as an alias. Use `--no-context-files` / `-nc` to disable loading, or `/reload` to reload mid-session.
