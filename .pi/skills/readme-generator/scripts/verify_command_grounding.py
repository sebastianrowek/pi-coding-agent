#!/usr/bin/env python3
"""Verify every shell command in Install/Usage/Contributing is grounded.

Input  (stdin, JSON): {"repo_root": str, "readme": str, "evidence": str}
Output (stdout, one JSON line): {"pass": bool, "reason": str, "details": {...}}
Exit: 0 pass, 1 fail, 2 malformed input.

Rule (deterministic, language-agnostic, no execution):
  1. Every command line shown in the Install / Usage / Quickstart /
     Contributing / Development sections must be covered by an evidence
     claim of kind "command" (claim.value equals or is a substring of
     the shown command, or vice versa).
  2. Any command claim whose evidence references a repo path, script, or
     build target must point at something that actually exists under
     repo_root (file on disk, Makefile target, or package.json script).
"""
import json
import os
import re
import sys

CMD_SECTIONS = {"install", "installation", "setup", "usage", "quickstart",
                "quick start", "getting started", "contributing", "development",
                "running tests", "tests"}
SH_LANGS = {"", "bash", "sh", "shell", "shell-session", "console", "shellsession", "zsh"}


def sections_with_commands(readme):
    """Return command lines that appear under command-ish H2 sections."""
    out = []
    cur = None
    in_fence = False
    fence_lang = None
    for line in readme.splitlines():
        m = re.match(r"^##\s+(.*)", line)
        if m and not in_fence:
            cur = m.group(1).strip().lower()
            continue
        fm = re.match(r"^```([\w-]*)", line.strip())
        if fm:
            if not in_fence:
                in_fence, fence_lang = True, fm.group(1).lower()
            else:
                in_fence, fence_lang = False, None
            continue
        if in_fence and cur in CMD_SECTIONS and fence_lang in SH_LANGS:
            s = line.strip()
            s = re.sub(r"^[\$#]\s+", "", s)
            if s and not s.startswith("#"):
                out.append(s)
    return out


def target_exists(repo_root, claim):
    """For a command claim that references a target, check it resolves."""
    val = claim.get("value", "")
    mk = re.match(r"^make\s+([\w.-]+)", val)
    if mk:
        mf = os.path.join(repo_root, "Makefile")
        if not os.path.isfile(mf):
            return False
        body = open(mf, encoding="utf-8", errors="replace").read()
        return re.search(rf"^{re.escape(mk.group(1))}\s*:", body, re.M) is not None
    nr = re.match(r"^(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)", val)
    if nr:
        pj = os.path.join(repo_root, "package.json")
        if not os.path.isfile(pj):
            return False
        scripts = json.load(open(pj, encoding="utf-8")).get("scripts", {})
        return nr.group(1) in scripts
    fr = re.match(r"^(?:\./|bash\s+|sh\s+|python3?\s+)(\S+)", val)
    if fr:
        return os.path.exists(os.path.join(repo_root, fr.group(1)))
    return True


def main():
    try:
        cfg = json.loads(sys.stdin.read())
        repo_root = cfg["repo_root"]
        readme = open(cfg["readme"], encoding="utf-8", errors="replace").read()
        ev = json.load(open(cfg["evidence"], encoding="utf-8"))
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(json.dumps({"pass": False, "reason": f"malformed input: {e}", "details": {}}))
        sys.exit(2)

    cmd_claims = [c for c in ev.get("claims", []) if c.get("kind") == "command"]
    claim_values = [c.get("value", "") for c in cmd_claims]

    shown = sections_with_commands(readme)
    ungrounded = []
    for cmd in shown:
        if not any(cmd == cv or cmd in cv or cv in cmd for cv in claim_values if cv):
            ungrounded.append(cmd)

    broken_targets = [c.get("value", "") for c in cmd_claims if not target_exists(repo_root, c)]

    details = {"commands_shown": shown, "command_claims": claim_values,
               "ungrounded": ungrounded, "broken_targets": broken_targets}
    if ungrounded or broken_targets:
        print(json.dumps({"pass": False,
                           "reason": f"ungrounded={ungrounded} broken_targets={broken_targets}",
                           "details": details}))
        sys.exit(1)
    print(json.dumps({"pass": True, "reason": "all shown commands grounded and targets resolve",
                       "details": details}))


if __name__ == "__main__":
    main()
