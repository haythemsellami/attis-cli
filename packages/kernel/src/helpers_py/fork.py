"""fork helper — anvil forks + forge PoC verification over JSON-RPC.

Stdlib only: chain access is raw JSON-RPC over urllib (no web3). Anvil
lifecycle and workspace layout mirror packages/fork/src (anvil.ts /
workspace.ts / runner.ts) so the two layers stay interchangeable:

  - ports: 18545 + random(4000), `--silent`, fork via --fork-url
  - template workspace: ~/.attis/forge-template (forge init + forge-std),
    created once and reused
  - each verify() copies the template into a fresh run dir (here: under
    the session scratch dir, kept as evidence) and drops the PoC in as
    test/Poc.t.sol

API: create(rpc_url=None, block=None), verify(poc_source, setup=None),
     snapshot(), revert(id), stop_all()
"""
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

CTX = None

TEMPLATE_DIR = os.path.expanduser("~/.attis/forge-template")
RUNS_SUBDIR = "poc-runs"

PASS_RE = "[PASS]"
FAIL_RE = "[FAIL"


def configure(ctx):
    global CTX
    CTX = ctx
    CTX.setdefault("forks", {})  # port -> subprocess.Popen
    CTX.setdefault("current", None)  # rpc url of the most recent fork


def _current():
    if not CTX.get("current"):
        raise RuntimeError("no anvil instance — call fork.create() first")
    return CTX["current"]


def rpc(method, params=None, url=None, timeout=15):
    """Raw JSON-RPC call against an anvil instance (default: current)."""
    body = json.dumps({"jsonrpc": "2.0", "method": method,
                       "params": params or [], "id": 1}).encode()
    req = urllib.request.Request(url or _current(), data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read().decode())
    if "error" in out:
        raise RuntimeError(f"{method} failed: {out['error']}")
    return out.get("result")


def _wait_ready(url, proc, timeout_s):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            rpc("eth_chainId", url=url, timeout=2)
            return True
        except Exception:
            time.sleep(0.4)
    return False


def create(rpc_url=None, block=None, ready_timeout_s=30):
    """Spawn an anvil instance and make it the current chain.

    Plain mode (no rpc_url): fresh local chain for source-only audits.
    Fork mode: `anvil --fork-url URL [--fork-block-number N]`. Falls back
    to RPC_URL / ETH_RPC_URL from the (scrubbed) environment.
    """
    anvil = shutil.which("anvil")
    if not anvil:
        raise RuntimeError("anvil not found on PATH (install foundryup)")
    rpc_url = rpc_url or os.environ.get("RPC_URL") or os.environ.get("ETH_RPC_URL")
    last_err = "unknown"
    for _attempt in range(8):
        port = 18545 + random.randint(0, 3999)  # mirror anvil.ts pickPort
        args = [anvil, "--port", str(port), "--silent"]
        if rpc_url:
            args += ["--fork-url", rpc_url]
            if block:
                args += ["--fork-block-number", str(block)]
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        url = f"http://127.0.0.1:{port}"
        if _wait_ready(url, proc, ready_timeout_s):
            CTX["forks"][port] = proc
            CTX["current"] = url
            return {"port": port, "rpc_url": url, "forked": bool(rpc_url),
                    "block": block}
        last_err = f"anvil on port {port} did not become ready"
        proc.kill()
    raise RuntimeError(f"fork.create failed: {last_err}")


def stop_all():
    """Kill every anvil instance spawned by this kernel."""
    for port, proc in list(CTX["forks"].items()):
        try:
            proc.kill()
        except Exception:
            pass
        del CTX["forks"][port]
    CTX["current"] = None


def snapshot():
    """evm_snapshot on the current chain; returns the snapshot id."""
    return rpc("evm_snapshot")


def revert(snapshot_id):
    """evm_revert on the current chain; raises if the id is unknown."""
    ok = rpc("evm_revert", [snapshot_id])
    if not ok:
        raise RuntimeError(f"evm_revert({snapshot_id}) returned false")
    return ok


def _ensure_template():
    """Create ~/.attis/forge-template once (mirrors workspace.ts)."""
    marker = os.path.join(TEMPLATE_DIR, "lib", "forge-std", "src", "Test.sol")
    if os.path.exists(marker):
        return TEMPLATE_DIR
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    if not os.path.exists(os.path.join(TEMPLATE_DIR, "foundry.toml")):
        subprocess.run(["forge", "init", "--no-git", "--force", TEMPLATE_DIR],
                       check=True, capture_output=True)
    if not os.path.exists(marker):
        subprocess.run(["forge", "install", "foundry-rs/forge-std", "--no-git"],
                       cwd=TEMPLATE_DIR, check=True, capture_output=True)
    return TEMPLATE_DIR


def _materialize(poc_source, extra_files):
    """Fresh run dir under scratch: template copy + PoC as test/Poc.t.sol."""
    import tempfile

    template = _ensure_template()
    runs_dir = os.path.join(CTX["scratch_dir"], RUNS_SUBDIR)
    os.makedirs(runs_dir, exist_ok=True)
    run_dir = tempfile.mkdtemp(prefix="run-", dir=runs_dir)
    shutil.copytree(template, run_dir, dirs_exist_ok=True)
    for rel, source in (extra_files or {}).items():
        dest = os.path.realpath(os.path.join(run_dir, rel))
        if not dest.startswith(os.path.realpath(run_dir) + os.sep):
            raise ValueError(f"setup file path escapes workspace: {rel!r}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as f:
            f.write(source)
    with open(os.path.join(run_dir, "test", "Poc.t.sol"), "w") as f:
        f.write(poc_source)
    return run_dir


def _parse_verdict(output):
    if PASS_RE in output and FAIL_RE not in output:
        return "verified"
    if FAIL_RE in output:
        return "reverted"
    return "error"


def _summarize(output, tail_lines=30):
    lines = output.strip().split("\n")
    interesting = [l for l in lines
                   if PASS_RE in l or FAIL_RE in l or "Suite result" in l
                   or "Traces:" in l or "revert" in l.lower()]
    tail = lines[-tail_lines:]
    summary = "\n".join(interesting[-10:])
    if summary:
        summary += "\n--- tail ---\n"
    return summary + "\n".join(tail)


def verify(poc_source, setup=None):
    """Write a PoC into a forge workspace, run `forge test`, parse output.

    setup (optional): {
        "rpc_url": run against this anvil (default: current chain, if any),
        "files":   {relpath: source} extra contracts (e.g. the target),
        "timeout_s": forge timeout (default 180),
    }

    Returns {"verdict": "verified" | "reverted" | "error",
             "state_diff": {...best-effort...},
             "traces_summary": str, "raw_log_path": str}.

    state_diff note: forge test does not emit structured state diffs, so
    this is populated best-effort from `vm.getRecordedLogs`-style output
    when present and otherwise left empty — strict verification should
    read balances/storage via fork.rpc() before and after (that is the
    pattern the audit loop uses).
    """
    setup = setup or {}
    forge = shutil.which("forge")
    if not forge:
        return {"verdict": "error", "state_diff": {}, "traces_summary": "",
                "raw_log_path": None,
                "error": "forge not found on PATH (install foundryup)"}
    run_dir = _materialize(poc_source, setup.get("files"))
    log_path = os.path.join(run_dir, "forge-output.log")
    args = [forge, "test", "--match-path", "test/Poc.t.sol", "-vvvv"]
    rpc_url = setup.get("rpc_url") or CTX.get("current")
    if rpc_url:
        args += ["--rpc-url", rpc_url]
    try:
        proc = subprocess.run(args, cwd=run_dir, capture_output=True, text=True,
                              timeout=setup.get("timeout_s", 180))
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        output = out + "\n" + err + f"\n<forge timed out after {e.timeout}s>"
    with open(log_path, "w") as f:
        f.write(output)
    return {
        "verdict": _parse_verdict(output),
        "state_diff": {},
        "traces_summary": _summarize(output),
        "raw_log_path": log_path,
    }
