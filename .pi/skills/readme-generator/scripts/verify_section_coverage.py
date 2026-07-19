#!/usr/bin/env python3
"""Verify the README contains every canonical section required for this repo.

Input  (stdin, JSON): {"repo_root": str, "readme": str, "evidence": str}
        readme/evidence are file paths.
Output (stdout, one JSON line): {"pass": bool, "reason": str, "details": {...}}
Exit: 0 pass, 1 fail, 2 malformed input.

Always-required: an H1 title, a non-empty description paragraph after it,
and the H2 sections Install, Usage, License. Sections listed in the
evidence map's "applicable_sections" are additionally required. Heading
matching is case-insensitive and accepts common synonyms.
"""
import json
import re
import sys

SYNONYMS = {
    "install": {"install", "installation", "setup", "getting started"},
    "usage": {"usage", "quickstart", "quick start", "getting started", "examples", "example"},
    "license": {"license", "licence", "licensing"},
    "api": {"api", "api reference", "reference", "api documentation"},
    "configuration": {"configuration", "config", "environment", "environment variables", "settings"},
    "contributing": {"contributing", "development", "develop", "contributing guide"},
    "tests": {"tests", "test", "testing", "running tests"},
}


def canonical(heading_text):
    h = heading_text.strip().lower()
    for key, names in SYNONYMS.items():
        if h in names:
            return key
    return h


def main():
    try:
        cfg = json.loads(sys.stdin.read())
        readme = open(cfg["readme"], encoding="utf-8", errors="replace").read()
        ev = json.load(open(cfg["evidence"], encoding="utf-8"))
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(json.dumps({"pass": False, "reason": f"malformed input: {e}", "details": {}}))
        sys.exit(2)

    lines = readme.splitlines()
    h1 = [l for l in lines if re.match(r"^#\s+\S", l)]
    h2 = [re.sub(r"^##\s+", "", l).strip() for l in lines if re.match(r"^##\s+\S", l)]
    present = {canonical(h) for h in h2}

    missing = []
    if not h1:
        missing.append("H1 title")
    desc_ok = False
    if h1:
        idx = lines.index(h1[0])
        for l in lines[idx + 1:]:
            s = l.strip()
            if not s:
                continue
            if s.startswith("#"):
                break
            desc_ok = len(s) >= 20
            break
    if not desc_ok:
        missing.append("description paragraph")

    required = {"install", "usage", "license"}
    for s in ev.get("applicable_sections", []):
        required.add(canonical(s))
    for r in sorted(required):
        if r not in present:
            missing.append(f"section: {r}")

    details = {"h2_present": sorted(present), "required": sorted(required)}
    if missing:
        print(json.dumps({"pass": False, "reason": f"missing: {missing}", "details": details}))
        sys.exit(1)
    print(json.dumps({"pass": True, "reason": "all required sections present", "details": details}))


if __name__ == "__main__":
    main()
