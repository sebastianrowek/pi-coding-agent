#!/usr/bin/env python3
"""Self-contained harness: builds a tiny fixture repo, a known-good and a
known-bad README, and asserts each verifier's pass/fail/malformed behavior.

Run: python3 scripts/verify_all.test.py   (exit 0 = all assertions held)
Place this file next to the five verify_*.py scripts.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFIERS = ["verify_section_coverage", "verify_command_grounding",
             "verify_link_integrity", "verify_code_fence_languages",
             "verify_evidence_provenance"]


def run(name, payload):
    p = subprocess.run([sys.executable, os.path.join(HERE, name + ".py")],
                        input=json.dumps(payload), capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def main():
    tmp = tempfile.mkdtemp()
    repo = os.path.join(tmp, "repo")
    os.makedirs(os.path.join(repo, "src", "pkg"))
    open(os.path.join(repo, "pyproject.toml"), "w").write('name = "demo"\n')
    open(os.path.join(repo, "Makefile"), "w").write("test:\n\tpytest\n")
    open(os.path.join(repo, "LICENSE"), "w").write("MIT License\n")
    open(os.path.join(repo, "src", "pkg", "__init__.py"), "w").write("def go(): pass\n")

    evidence = {
        "repo_archetype": "library", "ecosystems": ["python"], "languages": ["python"],
        "applicable_sections": ["Install", "Usage", "License"],
        "claims": [
            {"kind": "package_name", "value": "demo",
             "evidence": {"path": "pyproject.toml", "snippet": 'name = "demo"'}},
            {"kind": "command", "value": "pip install demo",
             "evidence": {"path": "pyproject.toml", "snippet": 'name = "demo"'}},
            {"kind": "command", "value": "make test",
             "evidence": {"path": "Makefile", "snippet": "test:"}},
            {"kind": "license", "value": "MIT",
             "evidence": {"path": "LICENSE", "snippet": "MIT License"}},
        ],
    }
    ev_path = os.path.join(repo, "readme-evidence.json")
    open(ev_path, "w").write(json.dumps(evidence))

    good = os.path.join(repo, "README.md")
    open(good, "w").write(
        "# demo\n\nA tiny demo library for testing this harness end to end.\n\n"
        "## Install\n\n```bash\npip install demo\n```\n\n"
        "## Usage\n\n```python\nimport pkg\n```\n\n"
        "## License\n\nMIT. See [LICENSE](LICENSE).\n")
    payload = {"repo_root": repo, "readme": good, "evidence": ev_path}
    for v in VERIFIERS:
        code, out = run(v, payload)
        assert code == 0 and out["pass"], f"{v} should PASS good readme: {out}"

    # known-bad: missing License section, hallucinated command, bad fence, dead link
    bad = os.path.join(repo, "BAD.md")
    open(bad, "w").write(
        "# demo\n\nA tiny demo library for testing this harness end to end.\n\n"
        "## Install\n\n```bash\npip install not-the-name\n```\n\n"
        "## Usage\n\n```rust\nfn main() {}\n```\n\n"
        "See [missing](docs/nope.md) and [bad anchor](#nope).\n")
    bp = {"repo_root": repo, "readme": bad, "evidence": ev_path}
    for v in ["verify_section_coverage", "verify_command_grounding",
              "verify_link_integrity", "verify_code_fence_languages"]:
        code, out = run(v, bp)
        assert code == 1 and not out["pass"], f"{v} should FAIL bad readme: {out}"

    # malformed input -> exit 2
    p = subprocess.run([sys.executable, os.path.join(HERE, "verify_section_coverage.py")],
                        input="not json", capture_output=True, text=True)
    assert p.returncode == 2, f"malformed should exit 2, got {p.returncode}"

    # fabricated provenance -> fail
    bad_ev = dict(evidence)
    bad_ev["claims"] = [{"kind": "command", "value": "pip install x",
                         "evidence": {"path": "pyproject.toml", "snippet": "name = \"ghost\""}}]
    bep = os.path.join(repo, "bad-ev.json")
    open(bep, "w").write(json.dumps(bad_ev))
    code, out = run("verify_evidence_provenance",
                    {"repo_root": repo, "readme": good, "evidence": bep})
    assert code == 1 and not out["pass"], f"provenance should FAIL fabricated snippet: {out}"

    print("ALL VERIFIER TESTS PASSED")


if __name__ == "__main__":
    main()
