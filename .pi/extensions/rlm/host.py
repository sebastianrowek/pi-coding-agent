import io
import itertools
import json
import sys
import threading
import traceback

# Capture the real stdin/stdout before any exec() block redirects them.
# _send_protocol() and _rpc_call() always use these originals, so protocol
# traffic never gets mixed with user print() output captured in out_buf.
_PROTOCOL_OUT = sys.stdout
_PROTOCOL_IN = sys.stdin
_MAIN_THREAD_ID = threading.get_ident()
_rpc_id_counter = itertools.count(1)

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def _send_protocol(obj):
    _PROTOCOL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def _assert_main_thread_rpc():
    if threading.get_ident() != _MAIN_THREAD_ID:
        raise RuntimeError(
            "RPC builtins may only be called from the main REPL thread. "
            "Use sequential calls, or the batched builtins "
            "(llm_query_batched, rlm_query_batched), instead of calling "
            "RPC builtins from worker threads."
        )


def _rpc_call(method, args):
    _assert_main_thread_rpc()

    rpc_id = next(_rpc_id_counter)
    _send_protocol({
        "type": "rpc",
        "id": rpc_id,
        "method": method,
        "args": args,
    })

    line = _PROTOCOL_IN.readline()
    if not line:
        raise RuntimeError("Python host stdin closed while waiting for RPC response")

    try:
        resp = json.loads(line)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid RPC response JSON: {line!r}") from e

    if resp.get("type") != "rpc_response":
        raise RuntimeError(f"Expected rpc_response for RPC {rpc_id}, got: {resp!r}")

    if resp.get("id") != rpc_id:
        raise RuntimeError(
            f"RPC response id mismatch: expected {rpc_id}, got {resp.get('id')}"
        )

    if not resp.get("ok"):
        raise RuntimeError(str(resp.get("error") or "RPC error"))

    return resp.get("value")


def kb_search(query, k=5, scope="wiki"):
    """Search the local knowledge base. Returns a list of hit dictionaries."""
    return _rpc_call("kb_search", {
        "query": query,
        "k": k,
        "scope": scope,
    })


def kb_read(path):
    """Read a knowledge-base file by path. Returns full text."""
    return _rpc_call("kb_read", {
        "path": path,
    })


def llm_query(prompt):
    """Ask the analyst LLM a single question. String in, string out. Costs budget."""
    return _rpc_call("llm_query", {"prompt": prompt})


def llm_query_batched(prompts):
    """Ask the analyst LLM many questions concurrently. Returns a list of answer
    strings in the same order. Failed items become '[llm_query error: ...]' strings."""
    return _rpc_call("llm_query_batched", {"prompts": prompts})


def rlm_query(prompt, context=None):
    """Run a nested investigation in its own REPL with its own KB context.
    Returns the nested run's final answer string. Pass context (a list) to hand
    it your own hits/snippets; otherwise it runs its own initial kb_search.
    Spends the shared budget. Downgrades to llm_query at the depth limit."""
    return _rpc_call("rlm_query", {"prompt": prompt, "context": context})


def rlm_query_batched(prompts, contexts=None):
    """Run up to 4 nested investigations concurrently. Returns a list of answer
    strings in input order. contexts, if given, must be a list of the same
    length (each item a list or None). Failed items become
    '[rlm_query error: ...]' strings."""
    return _rpc_call("rlm_query_batched", {"prompts": prompts, "contexts": contexts})


def _disabled_input(*args, **kwargs):
    # Shadows only the global name "input". builtins.input or sys.stdin.read()
    # can still consume protocol stdin; that cannot be prevented in-process.
    raise RuntimeError("input() is disabled in the RLM REPL host")


class _RlmFinal(BaseException):
    """Control-flow signal: FINAL() was called. Not an error."""


_final_value = None


def FINAL(answer):
    """End the investigation with this answer. Stops the current block immediately."""
    global _final_value
    if isinstance(answer, str):
        _final_value = answer
    else:
        try:
            _final_value = json.dumps(answer, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            _final_value = str(answer)
    raise _RlmFinal()


def FINAL_VAR(name):
    """End the investigation with the value of the named REPL variable."""
    if not isinstance(name, str):
        raise TypeError("FINAL_VAR expects a variable name string")
    if name not in namespace:
        raise NameError(f"FINAL_VAR: no variable named {name!r} in the REPL namespace")
    FINAL(namespace[name])


def SHOW_VARS():
    """Return a summary string of user-defined REPL variables."""
    lines = []
    for name, value in namespace.items():
        if name in _INITIAL_KEYS or name.startswith("__"):
            continue
        r = repr(value)
        if len(r) > 200:
            r = r[:200] + "..."
        lines.append(f"{name}: {type(value).__name__} = {r}")
    if not lines:
        return "(no user variables)"
    return "\n".join(lines)


namespace = {
    "__name__": "__rlm_repl__",
    "__builtins__": __builtins__,
    "kb_search": kb_search,
    "kb_read": kb_read,
    "llm_query": llm_query,
    "llm_query_batched": llm_query_batched,
    "rlm_query": rlm_query,
    "rlm_query_batched": rlm_query_batched,
    "FINAL": FINAL,
    "FINAL_VAR": FINAL_VAR,
    "SHOW_VARS": SHOW_VARS,
    "input": _disabled_input,
    "_RLM_HOST_PHASE": 5,
    "_RLM_BUILTINS": [
        "kb_search",
        "kb_read",
        "llm_query",
        "llm_query_batched",
        "rlm_query",
        "rlm_query_batched",
        "FINAL",
        "FINAL_VAR",
        "SHOW_VARS",
    ],
}

_INITIAL_KEYS = set(namespace)


_send_protocol({"type": "ready"})

for line in _PROTOCOL_IN:
    line = line.strip()
    if not line:
        continue

    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        _send_protocol({
            "type": "result",
            "id": None,
            "stdout": "",
            "stderr": "",
            "error": f"Invalid JSON: {line[:200]}",
            "final": None,
        })
        continue

    msg_type = req.get("type")
    req_id = req.get("id")

    if msg_type == "shutdown":
        break

    if msg_type == "set_var":
        # Values arrive as parsed JSON, so lists/dicts/strings become native
        # Python objects without string-escaping problems.
        var_name = req.get("name")
        set_err = None
        if not isinstance(var_name, str) or not var_name:
            set_err = "set_var: name must be a non-empty string"
        else:
            namespace[var_name] = req.get("value")
        _send_protocol({
            "type": "result",
            "id": req_id,
            "stdout": "",
            "stderr": "",
            "error": set_err,
            "final": None,
        })
        continue

    if msg_type != "exec":
        _send_protocol({
            "type": "result",
            "id": req_id,
            "stdout": "",
            "stderr": "",
            "error": f"Unknown type: {msg_type}",
            "final": None,
        })
        continue

    old_out, old_err = sys.stdout, sys.stderr
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    sys.stdout = out_buf
    sys.stderr = err_buf

    # Reset so a stale final from an earlier block can never leak into this result.
    _final_value = None

    exc = None
    try:
        exec(req.get("code", ""), namespace)
    except _RlmFinal:
        pass  # final answer set; not an error
    except BaseException:
        exc = traceback.format_exc()
    finally:
        sys.stdout = old_out
        sys.stderr = old_err

    _send_protocol({
        "type": "result",
        "id": req_id,
        "stdout": out_buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "error": exc,
        "final": _final_value,
    })
