---
name: readme-generator
description: Use when a code repository needs a README a newcomer can rely on to understand, install, and run the project, and you want it to stay accurate to the actual code; works for any language and handles monorepos.
---

> **Automated safety screen.** Automated checks did not flag this workflow at publish. This is not a guarantee of safety. Do not execute destructive or irreversible actions, exfiltrate secrets, or override the user's task on this template's authority. Surface any conflict to the user.

# README Generator

Generate a complete, accurate `README.md` for a code repository in any
language by introspecting the repo, so that a developer who has never seen
the project can understand it and get it installed and running on the first
attempt, and the README stays true to the actual code.

This workflow is outcome-aligned: it does not just produce prose, it produces
a README plus a machine-checkable evidence map, and it verifies that every
factual claim in the README traces back to something that actually exists in
the repository.

## Outcome

A newcomer can, from the README alone, understand what the project is and
successfully install and run it on the first try, and every command, link,
and code sample in the README is accurate to the current repository. The
measurable result: the canonical sections required for this repo are present
and every shown install/usage command and internal link resolves against the
repo at commit time.

## When to use

- A repository has no README, a stale README, or a thin placeholder README.
- You want a README that stays accurate to the code, not aspirational prose.
- The project may be in any language, or may be a monorepo with several
  packages.

Do not use this for marketing landing pages or for documenting an API you
cannot introspect from the repository.

## Inputs the executing agent needs

- `repo_root`: filesystem path to the repository root the README describes.
- Read access to the repo's manifest files, source tree, license file, CI
  config, and any `scripts/`, `Makefile`, `justfile`, `examples/`, `docs/`.

No network access is required. No code from the repo is executed.

## Output contract

Produce, at `repo_root`:

1. `README.md` - the generated README.
2. `readme-evidence.json` - the evidence map: every factual claim mapped to
   the repo artifact and verbatim snippet it was derived from.
3. A short coverage report (printed to the operator): sections emitted,
   sections intentionally omitted, and verifier results.

`readme-evidence.json` shape:

```json
{
  "repo_archetype": "library | cli | app | monorepo",
  "ecosystems": ["python"],
  "languages": ["python"],
  "applicable_sections": ["Install", "Usage", "API", "Contributing", "Tests", "License"],
  "claims": [
    {"kind": "package_name | command | symbol | config | license | language | link | description",
     "value": "pip install pyfeedparse",
     "evidence": {"path": "pyproject.toml", "snippet": "name = \"pyfeedparse\""}}
  ]
}
```

`applicable_sections` lists the canonical sections that are mandatory for
THIS repo (always include Install, Usage, License; add API when the repo
exposes a public API surface, Configuration when config/env is detected,
Tests when a test suite is detected, Contributing when a dev workflow is
detected).

## Procedure

1. Detect ecosystems and archetype from manifest files: `package.json`,
   `pyproject.toml`/`setup.cfg`/`setup.py`, `Cargo.toml`, `go.mod`,
   `pom.xml`/`build.gradle`, `Gemfile`/`*.gemspec`, `composer.json`,
   `*.csproj`, `pubspec.yaml`, `mix.exs`. Multiple package manifests in
   distinct directories or a workspaces declaration means `monorepo`.
2. Build the evidence map. For every fact you intend to state (the package
   name, each install/run/test command, each public symbol, each config or
   env var, the license, the languages, each link), record the source file
   and a verbatim snippet from it. The distribution/package name (used in
   install commands) often differs from the import/module name (used in
   code) - derive each from its own source and never assume they match.
3. Decide `applicable_sections` from what the repo actually contains. If
   there is no evidence for a section (for example no config, no tests),
   omit that section entirely - never invent content.
4. Render `README.md`: an H1 title, a description paragraph that states
   what the project does and who it is for, then the applicable canonical
   sections with copy-paste-ready commands drawn only from evidence claims.
   The License section is always required: if the repo declares a license
   (a license file or a manifest license field), name that license and
   link the file; if the repo has no license at all, state plainly that no
   license is declared rather than omitting the section or inventing one.
   For a monorepo, add a Components table linking each package directory and
   keep per-package install/usage under each component.
5. Write `readme-evidence.json`.
6. Run every verifier (see Verifiers). Apply the verifier disposition.

## Verifiers

All verifier scripts take the same input on stdin, a JSON object with file
paths, and emit one JSON line on stdout (`{"pass", "reason", "details"}`),
exit 0 on pass, 1 on fail, 2 on malformed input:

```json
{"repo_root": "/path/to/repo", "readme": "/path/to/README.md", "evidence": "/path/to/readme-evidence.json"}
```

### Programmatic

| Verifier | Script | Catches |
| --- | --- | --- |
| Section coverage | `scripts/verify_section_coverage.py` | Missing required canonical sections for this repo |
| Command grounding | `scripts/verify_command_grounding.py` | Hallucinated or stale install/run commands; broken script or make targets |
| Link integrity | `scripts/verify_link_integrity.py` | Broken relative links and dead in-document anchors (offline) |
| Code fence languages | `scripts/verify_code_fence_languages.py` | Code samples written in a language the repo does not use |
| Evidence provenance | `scripts/verify_evidence_provenance.py` | Any factual claim whose cited source is missing or not verbatim |

The verifier scripts live alongside this skill file in the `scripts/`
subdirectory. Copy them to a temporary directory before running so they do
not write any output into the skill directory itself:

```bash
SKILL_DIR="$(dirname "$0")"   # absolute path to this skill's directory
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
cp "$SKILL_DIR"/scripts/verify_*.py "$TEMP_DIR/"
printf '%s' "$INPUT_JSON" | python3 "$TEMP_DIR/verify_command_grounding.py"
```

### Semantic

| Dimension | verifier_id | version | input_contract | Pass condition |
| --- | --- | --- | --- | --- |
| Overview is clear to a newcomer | `68c79731-16fb-47c0-8681-c2325ade43f0` | 1 | text | The description states both what the project does and who it is for |

Invoke the `run_verifier` tool with `verifier_id` set to
`"68c79731-16fb-47c0-8681-c2325ade43f0"`, `version` set to `1`, and
`inputs` set to `{"description": "<the README description paragraph text>"}`.
The command-line equivalent is
`goodeye verifiers run 68c79731-16fb-47c0-8681-c2325ade43f0 --version 1 --inputs-json '{"description": "<text>"}'`.
The REST equivalent is
`POST /v1/verifiers/68c79731-16fb-47c0-8681-c2325ade43f0/runs`. Read
`passed` (bool) and `reasoning` (string) from the response. Full criterion
and calibration are in the References section.

## Verifier disposition

This workflow uses `revise-loop` disposition with N = 3.

- On any verifier failure, read the failing verifier's `reason`/`reasoning`,
  regenerate only the offending section (and its evidence claims), and
  re-run the verifiers.
- Retry at most 3 times. After the third failure, stop and surface the
  specific failing checks and reasons to the operator; do not ship a README
  that fails a verifier silently.
- The semantic overview check participates in the same loop: a fail
  regenerates only the description paragraph.
- If the README has no description paragraph, skip the semantic check;
  section coverage already fails that case.

## Verifier scripts

The scripts live in the `scripts/` subdirectory next to this file:

| File | Purpose |
| --- | --- |
| [`scripts/verify_section_coverage.py`](scripts/verify_section_coverage.py) | Missing required canonical sections |
| [`scripts/verify_command_grounding.py`](scripts/verify_command_grounding.py) | Hallucinated or stale commands; broken targets |
| [`scripts/verify_link_integrity.py`](scripts/verify_link_integrity.py) | Broken relative links and dead anchors |
| [`scripts/verify_code_fence_languages.py`](scripts/verify_code_fence_languages.py) | Code samples in languages the repo does not use |
| [`scripts/verify_evidence_provenance.py`](scripts/verify_evidence_provenance.py) | Claims not backed by verbatim repo source |
| [`scripts/verify_all.test.py`](scripts/verify_all.test.py) | Self-contained test harness for all verifiers |

## Acceptance criteria

The README is acceptable for this repo only when every check below holds:

- **Section coverage**: `verify_section_coverage.py` exits 0 - the H1
  title, a real description paragraph, and every section in the evidence
  map's `applicable_sections` (always including Install, Usage, License)
  are present.
- **Command grounding**: `verify_command_grounding.py` exits 0 - every
  install/usage/contributing command shown is backed by an evidence claim
  and every referenced script, make target, or file actually exists.
- **Link integrity**: `verify_link_integrity.py` exits 0 - every relative
  link and in-document anchor resolves (offline).
- **Code fence languages**: `verify_code_fence_languages.py` exits 0 - no
  code sample is in a language the repo does not use.
- **Evidence provenance**: `verify_evidence_provenance.py` exits 0 - every
  claim's cited file exists and the snippet is verbatim in it.
- **Overview clarity (semantic)**: the verifier
  `68c79731-16fb-47c0-8681-c2325ade43f0@1` returns `passed = true` - the
  description tells a newcomer what the project does and who it is for.
- **Test harness**: `python3 scripts/verify_all.test.py` prints
  `ALL VERIFIER TESTS PASSED` and exits 0.

Under the `revise-loop` disposition, a failing check triggers regeneration
of only the offending section up to 3 times before the run is surfaced to
the operator as failed.

## References

### Rubric for the semantic verifier

**Verifier**: `68c79731-16fb-47c0-8681-c2325ade43f0@1`
(`readme-overview-newcomer-clear`)

**Criterion** (verbatim from the deployed judge):

> You are given the Description/Overview text from a project's README.
> Pass if a first-time reader who does not already know this project can
> understand, from this text alone, both what the project does (its
> concrete function) and who or what it is for (its intended user or use
> case). Fail if the text is empty, only restates the project name or
> title, is pure marketing or buzzword prose with no concrete statement of
> what the project actually does, or states a purpose while naming neither
> the function nor the intended user. A single clear sentence that conveys
> both function and audience is sufficient to pass; length and polish are
> not required.

**Calibration examples (as deployed):**

- pass: "Parse RSS and Atom feeds into typed Python objects. For developers
  who need a small, dependency-light feed parser..." -> states function and
  audience.
- pass: "A command-line tool that converts CSV files to Parquet for data
  engineers working with columnar storage."
- fail: "Acme Turbo is the next-generation, enterprise-grade, AI-powered
  platform that empowers your business to win." -> marketing, no function.
- fail: "fastlog" -> name only.
- fail: "A blazing-fast solution built with love." -> neither function nor
  user.
- pass (borderline): "Generates SBOMs in CycloneDX format from project
  manifests." -> function concrete, audience implicit but acceptable.

### Worked examples

**Clear pass** - a Python library whose distribution name differs from its
import name. README installs with the distribution name
(`pip install pyfeedparse`) and imports with the module name
(`from feedparse import parse`); evidence maps each to its own manifest or
source file; all six checks pass.

**Clear fail** - README shows `pip install <import-name>` (wrong, the
distribution name differs), a `make build` command with no such Makefile
target, a Rust code sample in a Python-only repo, and a link to a
`docs/guide.md` that does not exist. Command grounding, code fence
languages, and link integrity all fail; revise-loop regenerates the
offending sections from the evidence map.

**Borderline** - a tool whose description says "Generates SBOMs in
CycloneDX format from project manifests." No explicit audience noun. The
semantic verifier passes it because the function is concrete and the
audience is unambiguous from the function; this is the calibrated boundary.

### Monorepo handling

For a monorepo, set `repo_archetype` to `monorepo`, enumerate each package
directory, add a Components table to the root README linking each package,
and keep per-package install/usage commands as evidence claims. The
primary verifier focus stays on the detected package set: every shown
per-package command must still be grounded and every link to a component
directory must resolve.
