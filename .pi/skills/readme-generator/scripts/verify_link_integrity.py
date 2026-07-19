#!/usr/bin/env python3
"""Verify README links resolve offline.

Input  (stdin, JSON): {"repo_root": str, "readme": str, "evidence": str}
Output (stdout, one JSON line): {"pass": bool, "reason": str, "details": {...}}
Exit: 0 pass, 1 fail, 2 malformed input.

Offline rules (portable, no network):
  - relative path links/images must resolve to a file under repo_root
  - in-document anchors (#slug) must match a heading's GitHub slug
  - absolute http(s)/mailto links are only syntax-checked, never fetched
"""
import json
import os
import re
import sys

LINK_RE = re.compile(r"!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
URL_RE = re.compile(r"^(https?://|mailto:)", re.I)


def gh_slug(heading):
    s = heading.strip().lower()
    s = re.sub(r"[^\w\- ]+", "", s)
    return re.sub(r"\s+", "-", s)


def main():
    try:
        cfg = json.loads(sys.stdin.read())
        repo_root = cfg["repo_root"]
        readme_path = cfg["readme"]
        readme = open(readme_path, encoding="utf-8", errors="replace").read()
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(json.dumps({"pass": False, "reason": f"malformed input: {e}", "details": {}}))
        sys.exit(2)

    anchors = {gh_slug(m.group(1)) for m in
               re.finditer(r"^#{1,6}\s+(.*)$", readme, re.M)}
    base = os.path.dirname(os.path.abspath(readme_path))

    broken = []
    for m in LINK_RE.finditer(readme):
        tgt = m.group(1).strip()
        if URL_RE.match(tgt):
            continue
        if tgt.startswith("#"):
            if tgt[1:].lower() not in anchors:
                broken.append(tgt)
            continue
        path_part = tgt.split("#", 1)[0]
        if not path_part:
            continue
        resolved = os.path.normpath(os.path.join(base, path_part))
        root = os.path.abspath(repo_root)
        if not (os.path.exists(resolved) and os.path.abspath(resolved).startswith(root)):
            broken.append(tgt)

    details = {"broken": broken, "anchors": sorted(anchors)}
    if broken:
        print(json.dumps({"pass": False, "reason": f"broken links: {broken}", "details": details}))
        sys.exit(1)
    print(json.dumps({"pass": True, "reason": "all relative links and anchors resolve",
                       "details": details}))


if __name__ == "__main__":
    main()
