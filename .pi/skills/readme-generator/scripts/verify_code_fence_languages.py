#!/usr/bin/env python3
"""Verify every fenced code block uses a language the repo actually uses.

Input  (stdin, JSON): {"repo_root": str, "readme": str, "evidence": str}
Output (stdout, one JSON line): {"pass": bool, "reason": str, "details": {...}}
Exit: 0 pass, 1 fail, 2 malformed input.

Allowed = languages declared in the evidence map's "languages" list
(normalized) plus a generic allowlist of shell/markup/config fences that
are acceptable in any README regardless of project language.
"""
import json
import re
import sys

GENERIC = {
    "", "bash", "sh", "shell", "shell-session", "shellsession", "console",
    "zsh", "text", "plaintext", "txt", "json", "jsonc", "yaml", "yml",
    "toml", "ini", "env", "dotenv", "dockerfile", "docker", "diff", "patch",
    "make", "makefile", "markdown", "md", "xml", "html", "csv", "tsv",
    "properties", "hcl", "regex",
}
ALIASES = {
    "py": "python", "python3": "python", "js": "javascript", "node": "javascript",
    "ts": "typescript", "rs": "rust", "golang": "go", "rb": "ruby",
    "cs": "csharp", "c++": "cpp", "kt": "kotlin", "ex": "elixir", "exs": "elixir",
}


def norm(lang):
    l = lang.strip().lower()
    return ALIASES.get(l, l)


def main():
    try:
        cfg = json.loads(sys.stdin.read())
        readme = open(cfg["readme"], encoding="utf-8", errors="replace").read()
        ev = json.load(open(cfg["evidence"], encoding="utf-8"))
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(json.dumps({"pass": False, "reason": f"malformed input: {e}", "details": {}}))
        sys.exit(2)

    repo_langs = {norm(x) for x in ev.get("languages", [])}
    allowed = repo_langs | GENERIC

    fences = re.findall(r"^```([\w.+#-]*)", readme, re.M)
    bad = []
    for raw in fences:
        if raw == "":
            continue
        if norm(raw) not in allowed:
            bad.append(raw)

    details = {"repo_languages": sorted(repo_langs),
               "fence_tags": sorted(set(f for f in fences if f)),
               "disallowed": sorted(set(bad))}
    if bad:
        print(json.dumps({"pass": False,
                           "reason": f"code fences in languages not in repo: {sorted(set(bad))}",
                           "details": details}))
        sys.exit(1)
    print(json.dumps({"pass": True, "reason": "all code fences use repo or generic languages",
                       "details": details}))


if __name__ == "__main__":
    main()
