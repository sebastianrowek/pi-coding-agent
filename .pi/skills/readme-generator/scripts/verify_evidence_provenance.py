#!/usr/bin/env python3
"""Verify every factual claim in the evidence map traces to a real source.

Input  (stdin, JSON): {"repo_root": str, "readme": str, "evidence": str}
Output (stdout, one JSON line): {"pass": bool, "reason": str, "details": {...}}
Exit: 0 pass, 1 fail, 2 malformed input.

This is the anti-hallucination backbone. The evidence map must:
  - validate against the required schema
  - have repo_archetype in the allowed enum
  - for every claim, the evidence.path must exist under repo_root and the
    evidence.snippet must be a verbatim substring of that file's text
"""
import json
import os
import sys

ARCHETYPES = {"library", "cli", "app", "monorepo"}
REQUIRED_TOP = {"repo_archetype", "languages", "applicable_sections", "claims"}
CLAIM_KINDS = {"package_name", "command", "symbol", "config", "license",
               "language", "link", "description"}


def main():
    try:
        cfg = json.loads(sys.stdin.read())
        repo_root = cfg["repo_root"]
        ev = json.load(open(cfg["evidence"], encoding="utf-8"))
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(json.dumps({"pass": False, "reason": f"malformed input: {e}", "details": {}}))
        sys.exit(2)

    errs = []
    missing_top = REQUIRED_TOP - set(ev or {})
    if missing_top:
        print(json.dumps({"pass": False, "reason": f"evidence missing keys: {sorted(missing_top)}",
                           "details": {}}))
        sys.exit(1)

    if ev.get("repo_archetype") not in ARCHETYPES:
        errs.append(f"repo_archetype not in {sorted(ARCHETYPES)}")

    root = os.path.abspath(repo_root)
    for i, c in enumerate(ev.get("claims", [])):
        if not isinstance(c, dict) or {"kind", "value", "evidence"} - set(c):
            errs.append(f"claim[{i}] missing kind/value/evidence")
            continue
        if c["kind"] not in CLAIM_KINDS:
            errs.append(f"claim[{i}] bad kind {c['kind']!r}")
        evd = c.get("evidence") or {}
        path, snip = evd.get("path"), evd.get("snippet")
        if not path or snip is None:
            errs.append(f"claim[{i}] evidence missing path/snippet")
            continue
        fp = os.path.normpath(os.path.join(repo_root, path))
        if not (os.path.isfile(fp) and os.path.abspath(fp).startswith(root)):
            errs.append(f"claim[{i}] evidence path does not exist: {path}")
            continue
        text = open(fp, encoding="utf-8", errors="replace").read()
        if snip not in text:
            errs.append(f"claim[{i}] snippet not verbatim in {path}: {snip!r}")

    details = {"claim_count": len(ev.get("claims", [])), "errors": errs}
    if errs:
        print(json.dumps({"pass": False, "reason": f"{len(errs)} provenance errors",
                           "details": details}))
        sys.exit(1)
    print(json.dumps({"pass": True, "reason": "every claim traces to a verbatim repo source",
                       "details": details}))


if __name__ == "__main__":
    main()
