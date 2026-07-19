# Docker for Node.js Development

## Purpose

Containerize the application to run it in an isolated environment with controlled filesystem access. Only directories explicitly mounted are visible to the container.

---

## Dockerfile Layers

A Dockerfile builds an image in layers. Each layer is cached independently.

### Layer Strategy for Node.js

```dockerfile
# Layer 1: Install dependencies (slow, cached unless lockfile changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Layer 2: Build (reruns on source changes, but skips dep install)
COPY packages/ ./packages/
RUN npm run build
```

Separating dep install from source copy means Docker skips `npm ci` when only source files change. This makes rebuilds fast during development.

---

## Why npm ci in Docker?

The workflow is:
1. **Host**: `npm install` to add/update deps → updates `package-lock.json`
2. **Docker build**: `npm ci` reads that lockfile and installs the exact same tree

This guarantees the container has exactly the same deps you tested locally. Using `npm install` in Docker could resolve different transitive versions, breaking reproducibility.

`--ignore-scripts` prevents untrusted third-party package scripts from executing with root privileges during image build.

---

## Build Inside Docker

`npm run build` inside the Dockerfile compiles TypeScript to JS within the container. Local source files are untouched.

- Docker copies your `.ts` source in, compiles it to `dist/`, and runs from `dist/`
- You don't need to build locally unless you're running the agent directly on your host
- Docker is self-contained: source goes in, built artifact comes out

---

## Mounting Local Directories

Use `-v` flags in `docker run` to expose host directories to the container:

```powershell
docker run --rm -it `
  -v "${PWD}:/workspace" `
  -v "$env:USERPROFILE\.pi\agent:/root/.pi/agent" `
  -v "C:\path\to\project:/workspace/my-project" `
  pi-local
```

Each `-v` is `host-path:container-path`.

### How the agent knows where to look

It doesn't auto-discover mounts. You either:
- Tell it in your prompt: "Look at `/workspace/my-project`"
- Start Docker from the directory you want (since `${PWD}` maps to `/workspace`)

The container has no visibility into anything not explicitly mounted.

---

## TLS/Proxy Certificates

For corporate environments with TLS-intercepting proxies:

```dockerfile
COPY --from=certs trusted_certs.crt /usr/local/share/ca-certificates/corporate.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

Required both at build time (npm reaching registry) and runtime (HTTPS calls to AI providers).

---

## Development Workflow with Docker

1. Edit `.ts` files locally
2. `npm install --ignore-scripts` if deps changed (updates `package-lock.json`)
3. `docker build` → Docker runs `npm ci` + `npm run build` inside the image
4. `docker run` → runs the compiled agent in isolation

The container rebuilds fast if only source changed (dep layer cached). If the lockfile changed, deps reinstall too.
