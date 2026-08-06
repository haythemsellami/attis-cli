#!/usr/bin/env python3
"""attis kernel sidecar — a persistent Python execution namespace over JSON-lines.

Protocol (stdin/stdout, one JSON object per line):
  request:  {"id": N, "code": "...", "timeout": <seconds, optional>}
  response: {"id": N, "ok": bool, "stdout": str, "stderr": str,
             "result": repr-of-last-expression-or-null,
             "error": {"type", "message", "traceback"} | null}

Semantics (prime-agent RLM shape, spec §6):
  - Persistent namespace: one globals dict survives across requests,
    including after exceptions in user code ("persistent IPython").
  - Stdlib only. web3/requests and any pip package are FORBIDDEN here;
    chain access goes through JSON-RPC over urllib (see helpers fork.py).
  - Per-exec timeout via signal.alarm (POSIX only; alarm is process-wide
    and integer-second granularity).
  - The sidecar chdirs into the session scratch dir at boot; the mounted
    repo is reachable read-only via the repo helper.
  - Boot line: {"id": 0, "ok": true, "boot": true, "helpers": [...]} is
    printed once helpers are injected; the TS kernel waits for it.

Usage: sidecar.py <scratch_dir> <repo_root> <helpers_dir>
"""
import ast
import contextlib
import importlib.util
import io
import json
import os
import signal
import sys
import traceback

# Audit helper library bootstrap list (spec §6): each entry is a plain
# <helpers_dir>/<name>.py module injected into the kernel namespace under
# its name. Adding a helper later = drop a file + one line here.
HELPERS = ["repo", "fork", "slither"]

MAX_RESULT_REPR = 10_000
MAX_STDIO = 200_000


class ExecTimeout(Exception):
    """Raised by the SIGALRM handler when a cell exceeds its timeout."""


def _on_alarm(signum, frame):
    raise ExecTimeout()


def _send(resp):
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()


def _load_helpers(helpers_dir, ctx):
    """Load each helper module and inject it into a fresh namespace dict."""
    ns = {"__name__": "__kernel__"}
    for name in HELPERS:
        path = os.path.join(helpers_dir, name + ".py")
        spec = importlib.util.spec_from_file_location(f"attis_helper_{name}", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if hasattr(mod, "configure"):
            mod.configure(ctx)
        ns[name] = mod
    return ns


def _compile_cell(code):
    """Split a cell into (exec_part, eval_part): if the last statement is a
    bare expression it is evaluated separately so its repr becomes `result`."""
    tree = ast.parse(code, mode="exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body[-1].value)
        head = ast.Module(body=tree.body[:-1], type_ignores=[])
        ast.fix_missing_locations(last)
        ast.fix_missing_locations(head)
        return compile(head, "<cell>", "exec"), compile(last, "<cell>", "eval")
    return compile(tree, "<cell>", "exec"), None


def _truncate(s, limit):
    if len(s) > limit:
        return s[:limit] + "\n... <truncated>"
    return s


def _handle(req, ns):
    rid = req.get("id")
    code = req.get("code", "")
    timeout = int(req.get("timeout", 110))
    out, err = io.StringIO(), io.StringIO()
    result_repr = None
    error = None

    if hasattr(signal, "SIGALRM"):
        signal.alarm(max(1, timeout))
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec_part, eval_part = _compile_cell(code)
            exec(exec_part, ns)
            if eval_part is not None:
                value = eval(eval_part, ns)
                if value is not None:
                    result_repr = _truncate(repr(value), MAX_RESULT_REPR)
    except ExecTimeout:
        error = {
            "type": "TimeoutError",
            "message": f"execution exceeded {timeout}s (signal.alarm)",
            "traceback": "",
        }
    except BaseException:  # noqa: BLE001 — user code must never kill the sidecar
        exc = sys.exc_info()[1]
        error = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": _truncate(traceback.format_exc(), MAX_RESULT_REPR),
        }
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)

    return {
        "id": rid,
        "ok": error is None,
        "stdout": _truncate(out.getvalue(), MAX_STDIO),
        "stderr": _truncate(err.getvalue(), MAX_STDIO),
        "result": result_repr,
        "error": error,
    }


def main():
    scratch_dir, repo_root, helpers_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(scratch_dir, exist_ok=True)
    os.chdir(scratch_dir)

    # Shared mutable context handed to every helper module (fork handles,
    # current chain, scratch/repo paths). Helpers keep their state here so
    # it survives across cells exactly like the namespace does.
    ctx = {"repo_root": repo_root, "scratch_dir": scratch_dir}
    ns = _load_helpers(helpers_dir, ctx)

    # Kill forked anvil children on the way out so a stopped kernel never
    # leaves stray (billing-free but port-hogging) processes behind.
    def _cleanup_forks():
        for proc in (ctx.get("forks") or {}).values():
            try:
                proc.kill()
            except Exception:
                pass

    import atexit

    atexit.register(_cleanup_forks)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _on_alarm)

    _send({"id": 0, "ok": True, "boot": True, "helpers": HELPERS})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _send({"id": None, "ok": False, "stdout": "", "stderr": "",
                   "result": None,
                   "error": {"type": "ProtocolError", "message": str(e), "traceback": ""}})
            continue
        _send(_handle(req, ns))


if __name__ == "__main__":
    main()
