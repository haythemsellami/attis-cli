"""fork helper — anvil forks + forge PoC verification over JSON-RPC.

Stdlib only: chain access is raw JSON-RPC over urllib (no web3). Anvil
lifecycle and workspace layout mirror packages/fork/src (anvil.ts /
workspace.ts / runner.ts) so the two layers stay interchangeable:

  - ports: 18545 + random(4000), `--silent`, fork via --fork-url
  - template workspace: ~/.attis/forge-template (forge init + forge-std),
    created once and reused
  - standard libraries (forge-std, openzeppelin-contracts, solmate, solady)
    come from the shared deps cache (deps.py, ~/.attis/deps) — GitHub
    tarballs strip submodules, so audited repos never ship lib/. forge-std
    is era-picked: repos whose pragmas cap solc below 0.8.13 get the
    forge-std-legacy variant (v1.5.6) instead of latest

verify() picks a mode per call:

  - repo mode (a foundry root exists in the mounted repo COPY, or
    setup["foundry_root"] points at one): the PoC drops into
    <foundry_root>/test/attis_poc/, missing standard libs are symlinked
    from the deps cache into <foundry_root>/lib/ (only when that exact lib
    dir is absent), and `forge test` runs from the foundry root with the
    repo's own remappings. The PoC dir is removed afterwards.
  - template mode (no foundry root): the bare template workspace gets the
    repo's .sol tree staged under src/repo/ (importable as `repo/<path>`)
    plus a remappings.txt pointing forge-std/@openzeppelin/solmate/solady
    at the deps cache.

Both modes copy forge-output.log to a durable location when the sidecar
env carries ATTIS_JOURNAL_DIR (the journal session dir) — raw_log_path in
the verdict points at the durable copy so scratch cleanup never orphans
evidence. The ATTIS_FORK_VERDICT marker carries "mode" ("repo"|"template").

API: create(rpc_url=None, block=None), verify(poc_source, setup=None),
     snapshot(), revert(id), stop_all(), find_foundry_root(repo_root)
"""
import json
import os
import random
import re
import shutil
import subprocess
import time
import urllib.request

CTX = None

TEMPLATE_DIR = os.path.expanduser("~/.attis/forge-template")
RUNS_SUBDIR = "poc-runs"

PASS_RE = "[PASS]"
FAIL_RE = "[FAIL"

IMPORT_RE = re.compile(r"""^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']""", re.M)
MISSING_IMPORT_RE = re.compile(r'Source "([^"]+)" not found')

# Directories that carry no audit signal (VCS metadata, deps, build output).
SKIP_DIRS = {".git", "node_modules", "out", "cache", "broadcast", "lib", "artifacts"}
# Repo dirs that must not be staged into template mode's src/repo/ copy.
NON_SOURCE_DIRS = SKIP_DIRS | {"test", "tests", "script", "scripts", "mock", "mocks"}

# foundry.toml at the repo root or nested at most this many dir levels.
FOUNDRY_ROOT_MAX_DEPTH = 2

# Standard libs repo-mode symlinks beyond forge-std only when the repo's
# remappings/config/imports reference them: dep name -> marker substring.
STD_LIB_REFS = {
    "openzeppelin-contracts": ("@openzeppelin", "openzeppelin-contracts"),
    # "@openzeppelin/upgrades" is the 2021 hardhat-era alias of the
    # upgradeable package (see _alias_target for its layout quirks).
    "openzeppelin-contracts-upgradeable": ("@openzeppelin/contracts-upgradeable",
                                           "openzeppelin-contracts-upgradeable",
                                           "@openzeppelin/upgrades"),
    "solmate": ("solmate",),
    "solady": ("solady",),
}

# Next-older era per deps-cache name, for the compile-fallback retry:
# repo written against OZ v4 APIs compiles neither against latest (v5)
# nor vice versa, and no pragma can tell them apart — so a compile-mismatch
# error verdict steps the era down once (v4 era keeps forge-std latest;
# legacy era takes forge-std-legacy — see _step_down_eras).
_OLDER_ERA = {
    "openzeppelin-contracts": "openzeppelin-contracts-v4",
    "openzeppelin-contracts-v4": "openzeppelin-contracts-legacy",
    "openzeppelin-contracts-upgradeable": "openzeppelin-contracts-upgradeable-v4",
    "openzeppelin-contracts-upgradeable-v4": "openzeppelin-contracts-upgradeable-legacy",
    "forge-std": "forge-std-legacy",
}

# Forge/solc output that means "compiled against the wrong major of a dep"
# (never produced by a legitimate PoC revert — fallback fires only on
# "error" verdicts anyway).
COMPILE_MISMATCH_MARKERS = (
    "Wrong argument count for modifier invocation",
    "Trying to override non-virtual function",
    "does not override anything",
    "Overriding function return types differ",
    "Overriding function is missing",
    # super.<renamed-method>(...) — the parent contract's API moved.
    "not found or not visible after argument-dependent lookup in type(contract super",
)

# The 2021 alias' imports: `@openzeppelin/upgrades/contracts/<suffix>`.
ALIAS_IMPORT_RE = re.compile(r"""["']@openzeppelin/upgrades/contracts/([^"']+)["']""")

# Canonical remapping each provisioned lib needs for its INTERNAL imports
# (e.g. openzeppelin-contracts-upgradeable's sources import
# @openzeppelin/contracts/...) — repos with their own prefix style
# (openzeppelin-upgradeable/=lib/...) don't cover these. Lib dir names are
# canonical: our symlinks land at lib/<name> even for era-variant picks.
CANONICAL_REMAPPINGS = {
    "forge-std": "forge-std/=lib/forge-std/src/",
    "openzeppelin-contracts":
        "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "openzeppelin-contracts-upgradeable":
        "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
    "solmate": "solmate/=lib/solmate/src/",
    "solady": "solady/=lib/solady/src/",
}


def configure(ctx):
    global CTX
    CTX = ctx
    CTX.setdefault("forks", {})  # port -> subprocess.Popen
    CTX.setdefault("current", None)  # rpc url of the most recent fork


def _deps():
    """Lazy-load the sibling deps helper (helpers are importlib-loaded, so a
    plain `import deps` only works with the helpers dir on sys.path)."""
    import importlib.util

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deps.py")
    spec = importlib.util.spec_from_file_location("attis_helper_deps_impl", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def _count_sol(root):
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        n += sum(1 for fn in filenames if fn.endswith(".sol"))
    return n


def find_foundry_root(repo_root):
    """Dir holding foundry.toml at the repo root or nested <=2 levels.

    Prefer the shallowest candidate (the real project root beats vendored
    examples); break ties by the most .sol files under the candidate.
    Returns the realpath, or None when the repo has no foundry project
    (Hardhat-era repos — verify() falls back to template mode).
    """
    root = os.path.realpath(repo_root)
    if not os.path.isdir(root):
        return None
    candidates = []  # (depth, dir)
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and depth < FOUNDRY_ROOT_MAX_DEPTH]
        if "foundry.toml" in filenames:
            candidates.append((depth, dirpath))
    if not candidates:
        return None
    best = min(candidates, key=lambda c: (c[0], -_count_sol(c[1])))
    return best[1]


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


def _stage_repo_sources(run_dir):
    """Template mode: copy the repo's .sol tree into <run_dir>/src/repo/.

    Relative paths are preserved so imports between repo files keep
    resolving; test/script/mocks dirs are skipped (no audit signal, and
    they drag in lib imports the stripped tarball cannot satisfy). The PoC
    reaches repo contracts as `repo/<path>` (see _write_remappings).
    """
    repo_root = CTX.get("repo_root")
    if not repo_root or not os.path.isdir(repo_root):
        return 0
    repo_root = os.path.realpath(repo_root)
    staged = 0
    for dirpath, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = [d for d in dirnames if d.lower() not in NON_SOURCE_DIRS]
        for fn in filenames:
            if not fn.endswith(".sol"):
                continue
            src = os.path.join(dirpath, fn)
            rel = os.path.relpath(src, repo_root)
            dest = os.path.join(run_dir, "src", "repo", rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(src, dest)
            staged += 1
    return staged


def _referenced_std_libs(text):
    """Deps-cache libs the given sources/remappings reference.

    Two detection styles: STD_LIB_REFS markers ("@-style" imports like
    @openzeppelin/contracts/...) and registry-name path prefixes —
    `lib/<name>/...` (remapping targets and escher-style direct imports)
    and `<name>/...` import prefixes, matched as the substring `<name>/`
    against the deps registry. The upgradeable package always pairs with
    plain openzeppelin-contracts (its foundry setup expects the sibling),
    so referencing it provisions both.
    """
    found = [name for name, markers in STD_LIB_REFS.items()
             if any(m in text for m in markers)]
    for name in _deps().DEPS:
        if name in ("forge-std", "forge-std-legacy") or name in found:
            continue
        if f"{name}/" in text:
            found.append(name)
    if ("openzeppelin-contracts-upgradeable" in found
            and "openzeppelin-contracts" not in found):
        found.append("openzeppelin-contracts")
    return found


def _write_remappings(run_dir, dep_paths, forge_std="forge-std", canonical=None,
                      alias_target=None):
    """Template mode remappings: deps-cache libs + repo/=src/repo/.

    forge_std is the era-picked variant (deps.pick_dep): latest prefers
    the template's own lib/forge-std; legacy always remaps to the deps
    cache (the template's lib IS latest — unusable below solc 0.8.13).
    `canonical` maps canonical lib names to the era-picked cache name
    (e.g. openzeppelin-contracts -> openzeppelin-contracts-legacy). When
    a picked variant is absent from the cache (offline), fall back to
    whatever exists and let the verdict carry the compile error with its
    hint."""
    canonical = canonical or {}
    template_std = os.path.join(run_dir, "lib", "forge-std", "src")
    lines = []
    if forge_std != "forge-std" and dep_paths.get(forge_std):
        lines.append(f"forge-std/={dep_paths[forge_std]}/src/")
        # v1.5.6's Test.sol imports ds-test (submodule living inside the
        # forge-std clone) — the cache is outside lib/, so forge's lib/
        # auto-detection can't see it; remap explicitly.
        ds_test = os.path.join(dep_paths[forge_std], "lib", "ds-test", "src")
        if os.path.isdir(ds_test):
            lines.append(f"ds-test/={ds_test}/")
    elif os.path.isdir(template_std):
        lines.append("forge-std/=lib/forge-std/src/")
    elif dep_paths.get("forge-std"):
        lines.append(f"forge-std/={dep_paths['forge-std']}/src/")
    oz = dep_paths.get(canonical.get("openzeppelin-contracts", "openzeppelin-contracts"))
    if oz:
        lines.append(f"@openzeppelin/contracts/={oz}/contracts/")
    for name, prefix in (("solmate", "solmate/"), ("solady", "solady/")):
        path = dep_paths.get(canonical.get(name, name))
        if path:
            lines.append(f"{prefix}={path}/src/")
    upg = dep_paths.get(canonical.get("openzeppelin-contracts-upgradeable",
                                      "openzeppelin-contracts-upgradeable"))
    if upg:
        # Both the package-root form (lib/<name>/... and <name>/... style
        # imports) and the canonical @-style form.
        lines.append(f"openzeppelin-contracts-upgradeable/={upg}/")
        lines.append(f"@openzeppelin/contracts-upgradeable/={upg}/contracts/")
    if alias_target:
        # The 2021 hardhat-era alias of the upgradeable package.
        lines.append(f"@openzeppelin/upgrades/contracts/={alias_target}/")
    lines.append("repo/=src/repo/")
    with open(os.path.join(run_dir, "remappings.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")


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


def _missing_import_hint(output):
    """First missing-import specifier in forge output, if any — the model
    uses it to adapt (add the file via setup.files or fix the import)."""
    m = MISSING_IMPORT_RE.search(output)
    return m.group(1) if m else None


def _durable_log(scratch_log_path, mode):
    """Copy the raw forge log into the journal session dir when the sidecar
    env carries ATTIS_JOURNAL_DIR; the verdict points at the durable copy so
    scratch cleanup never orphans evidence. Falls back to the scratch path."""
    journal_dir = os.environ.get("ATTIS_JOURNAL_DIR")
    if not journal_dir:
        return scratch_log_path
    try:
        dest_dir = os.path.join(journal_dir, "poc-logs")
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, f"{int(time.time() * 1000)}-{mode}.log")
        shutil.copyfile(scratch_log_path, dest)
        return dest
    except Exception:
        return scratch_log_path


def _emit_verdict(v):
    """Print the canonical machine-readable verdict line (journal label
    extraction keys off ATTIS_FORK_VERDICT in kernel_exec stdout), then return."""
    print("ATTIS_FORK_VERDICT " + json.dumps({
        "verdict": v.get("verdict"), "raw_log_path": v.get("raw_log_path"),
        "mode": v.get("mode"), "era": v.get("era")}))
    return v


def _run_forge(forge, match_path, cwd, setup, extra_args=None):
    """forge test for one PoC file; returns combined stdout+stderr."""
    args = [forge, "test", "--match-path", match_path, "-vvvv"]
    rpc_url = setup.get("rpc_url") or CTX.get("current")
    if rpc_url:
        args += ["--rpc-url", rpc_url]
    args += extra_args or []
    try:
        proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                              timeout=setup.get("timeout_s", 180))
        return (proc.stdout or "") + "\n" + (proc.stderr or "")
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        return out + "\n" + err + f"\n<forge timed out after {e.timeout}s>"


def _verdict_from(output, mode, log_path, era=None):
    v = {"verdict": _parse_verdict(output),
         "state_diff": {},
         "traces_summary": _summarize(output),
         "raw_log_path": log_path,
         "mode": mode,
         "era": era}
    if v["verdict"] == "error":
        hint = _missing_import_hint(output)
        if hint:
            v["missing_import"] = hint
            v["traces_summary"] += (
                f'\nhint: import "{hint}" not found — provide it via '
                "setup.files or adjust the PoC's imports")
    return v


def _resolve_foundry_override(setup):
    """setup['foundry_root']: model override pointing at a (possibly nested)
    project dir. Confined to the mounted repo copy like repo.resolve()."""
    override = setup.get("foundry_root")
    if not override:
        return None
    repo_root = os.path.realpath(CTX.get("repo_root") or os.getcwd())
    full = os.path.realpath(os.path.join(repo_root, override))
    if full != repo_root and not full.startswith(repo_root + os.sep):
        raise ValueError(f"foundry_root escapes repo root: {override!r}")
    if not os.path.isdir(full):
        raise ValueError(f"foundry_root is not a directory: {override!r}")
    return full


def _is_compile_mismatch(output):
    """True when forge failed to compile due to a dep version mismatch
    (API change across OZ majors, or a missing import path). A reverted
    PoC is a real verdict — callers gate on verdict == "error" first."""
    if any(m in output for m in COMPILE_MISMATCH_MARKERS):
        return True
    return bool(MISSING_IMPORT_RE.search(output)) or "No such file or directory" in output


def _era_label(forge_std, oz_deps):
    """The effective dep era of a provisioning pass: the OZ family's era
    when OZ deps are provisioned, else forge-std's."""
    oz = list(oz_deps)
    if any(d.endswith("-legacy") for d in oz):
        return "legacy"
    if any(d.endswith("-v4") for d in oz):
        return "v4"
    if oz:
        return "latest"
    return "legacy" if forge_std == "forge-std-legacy" else "latest"


def _can_step_down(forge_std, oz_deps):
    """True when any provisioned dep has an older era to fall back to."""
    return any(_OLDER_ERA.get(d) for d in list(oz_deps) + [forge_std])


def _step_down_eras(forge_std, canonical):
    """One era older, consistently across the forge-std + OZ families:
    OZ steps latest -> v4 -> legacy; forge-std goes legacy when the OZ
    family lands on legacy or when no OZ dep is provisioned (the v4 era
    keeps forge-std latest)."""
    stepped = {n: (_OLDER_ERA.get(v) or v) for n, v in canonical.items()}
    if not stepped or any(v.endswith("-legacy") for v in stepped.values()):
        forge_std = "forge-std-legacy"
    return forge_std, stepped


def _alias_suffixes(text):
    """Paths referenced via the @openzeppelin/upgrades alias (suffixes
    after `@openzeppelin/upgrades/contracts/`)."""
    return ALIAS_IMPORT_RE.findall(text)


def _alias_target(deps, texts, upg_path):
    """Base dir the `@openzeppelin/upgrades/contracts/` prefix should map
    to, or None when the alias isn't referenced.

    The 2021 npm alias (@openzeppelin/upgrades <= 2.8.0) is the old sdk
    package with ROOT-LEVEL contracts (contracts/Initializable.sol) — a
    layout openzeppelin-contracts-upgradeable never shipped (v3+ keeps it
    at contracts/proxy/). So the target is picked by existence probe:
    the era-picked upgradeable cache when the referenced paths exist
    there, else the sdk legacy package (packages/lib/contracts)."""
    suffixes = _alias_suffixes("\n".join(texts))
    if not suffixes:
        return None
    if upg_path and any(os.path.exists(os.path.join(upg_path, "contracts", s))
                        for s in suffixes):
        return os.path.join(upg_path, "contracts")
    sdk = deps.ensure(["openzeppelin-upgrades-legacy"]).get("openzeppelin-upgrades-legacy")
    if sdk:
        base = os.path.join(sdk, "packages", "lib", "contracts")
        if any(os.path.exists(os.path.join(base, s)) for s in suffixes):
            return base
    # Best-effort default: the era-picked package (correct layout for
    # modern-style alias imports; a wrong guess ends as an error verdict
    # with the missing-import hint).
    return os.path.join(upg_path, "contracts") if upg_path else None


def _remapping_prefixes(foundry_root):
    """Prefixes the repo already remaps, from remappings.txt AND
    foundry.toml (foundry merges both; a prefix mapped in either covers).
    Coverage is exact-prefix: `openzeppelin/` does NOT cover
    `@openzeppelin/contracts/`."""
    prefixes = set()
    path = os.path.join(foundry_root, "remappings.txt")
    if os.path.isfile(path):
        with open(path, errors="replace") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    prefixes.add(line.split("=", 1)[0].strip())
    toml = os.path.join(foundry_root, "foundry.toml")
    if os.path.isfile(toml):
        with open(toml, errors="replace") as f:
            content = f.read()
        # remappings live as quoted "prefix=target" strings in the toml.
        for m in re.finditer(r"""["']([^"']+=[^"']+)["']""", content):
            prefixes.add(m.group(1).split("=", 1)[0].strip())
    return prefixes


def _ensure_canonical_remappings(foundry_root, lib_names, extra_lines=()):
    """Append the canonical remapping lines for provisioned libs to the
    repo COPY's remappings.txt (created when absent — foundry merges it
    with foundry.toml remappings). extra_lines are full "prefix=target"
    entries (e.g. the @openzeppelin/upgrades alias) handled by the same
    coverage rule. Skips prefixes the repo already maps (the repo's own
    target wins) and lines already appended by an earlier verify call in
    this session. Returns the lines appended."""
    prefixes = _remapping_prefixes(foundry_root)
    lines = []
    for line in [CANONICAL_REMAPPINGS.get(n) for n in lib_names] + list(extra_lines):
        if not line:
            continue
        prefix = line.split("=", 1)[0]
        if prefix in prefixes:
            continue
        prefixes.add(prefix)
        lines.append(line)
    if not lines:
        return []
    path = os.path.join(foundry_root, "remappings.txt")
    with open(path, "a+") as f:
        f.seek(0)  # a+ starts at EOF; reads need the head
        # NB: no header comment — foundry's remappings.txt parser rejects
        # anything that isn't <key>=<value>.
        existing = f.read()
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write("\n".join(lines) + "\n")
    return lines


def _symlink_std_libs(foundry_root, poc_source, step_down=False):
    """Symlink missing standard libs from the deps cache into <root>/lib/.

    forge-std always (PoCs import forge-std/Test.sol) — era-picked via
    deps.pick_dep so era-pinned repos get legacy variants their solc can
    satisfy; the others only when the repo's remappings/config or .sol
    imports reference them (OZ packages era-picked the same way). A lib
    dir that already exists (vendored, non-stripped) is left untouched.
    Afterwards, canonical @-style remappings the libs' internal imports
    need are appended to the copy's remappings.txt (only prefixes the
    repo doesn't already map).

    step_down=True is the compile-fallback retry: every dep is re-picked
    one era older and OUR symlinks are re-pointed at the older cache
    dirs (vendored real dirs are never touched).

    Returns (linked, paths, era, can_step_down).
    """
    deps = _deps()
    texts = [poc_source]
    for fname in ("remappings.txt", "foundry.toml"):
        path = os.path.join(foundry_root, fname)
        if os.path.isfile(path):
            with open(path, errors="replace") as f:
                texts.append(f.read())
    for dirpath, dirnames, filenames in os.walk(foundry_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".sol"):
                try:
                    with open(os.path.join(dirpath, fn), errors="replace") as f:
                        texts.append(f.read())
                except OSError:
                    pass
    # Era detection scans the repo sources, not the PoC (texts[0]).
    lower, upper = deps.repo_solc_bounds(texts[1:])
    forge_std = deps.pick_dep("forge-std", upper, lower)
    # canonical lib name -> era-picked cache name (identity for most).
    canonical = {n: deps.pick_dep(n, upper, lower)
                 for n in _referenced_std_libs("\n".join(texts))}
    can_step = _can_step_down(forge_std, canonical.values())
    if step_down:
        forge_std, canonical = _step_down_eras(forge_std, canonical)
    # (lib/ dir name, deps-cache name) — era variants still land under the
    # canonical lib/ dir so the repo's remappings resolve unchanged.
    wanted = [("forge-std", forge_std)]
    wanted += [(n, v) for n, v in canonical.items()]
    paths = deps.ensure(sorted({dep for _, dep in wanted}))
    linked = []
    lib_dir = os.path.join(foundry_root, "lib")
    for lib_name, dep_name in wanted:
        dest = os.path.join(lib_dir, lib_name)
        target = paths.get(dep_name)
        if not target:
            continue
        if os.path.islink(dest):
            if step_down and os.path.realpath(dest) != os.path.realpath(target):
                os.unlink(dest)  # re-point our symlink at the older era
            else:
                continue
        elif os.path.lexists(dest):
            continue
        os.makedirs(lib_dir, exist_ok=True)
        os.symlink(target, dest)
        linked.append(lib_name)
    # forge-std v1.5.6 imports ds-test from its own lib/ submodule; expose
    # it at lib/ds-test too, where forge's auto-detection definitely looks.
    legacy = paths.get("forge-std-legacy")
    if forge_std == "forge-std-legacy" and legacy:
        ds_test = os.path.join(legacy, "lib", "ds-test")
        dest = os.path.join(lib_dir, "ds-test")
        if os.path.isdir(ds_test) and not os.path.lexists(dest):
            os.makedirs(lib_dir, exist_ok=True)
            os.symlink(ds_test, dest)
            linked.append("ds-test")
    # The libs' internal imports use canonical @-style prefixes the repo's
    # own remappings may not cover (escher: openzeppelin-upgradeable/=...
    # but the package imports @openzeppelin/contracts/...). Append the
    # canonical lines for every lib now present (provisioned or vendored).
    present = [lib_name for lib_name, _ in wanted
               if os.path.lexists(os.path.join(lib_dir, lib_name))]
    extra = []
    upg_path = paths.get(canonical.get("openzeppelin-contracts-upgradeable", ""))
    alias_base = _alias_target(deps, texts, upg_path)
    if alias_base:
        if upg_path and alias_base.startswith(upg_path + os.sep):
            alias_lib = "openzeppelin-contracts-upgradeable"
        else:
            # The old sdk package (packages/lib) — expose it as
            # lib/openzeppelin-upgrades.
            alias_lib = "openzeppelin-upgrades"
            dest = os.path.join(lib_dir, alias_lib)
            sdk_root = os.path.dirname(alias_base)
            if not os.path.lexists(dest):
                os.makedirs(lib_dir, exist_ok=True)
                os.symlink(sdk_root, dest)
                linked.append(alias_lib)
        extra.append(f"@openzeppelin/upgrades/contracts/=lib/{alias_lib}/contracts/")
    _ensure_canonical_remappings(foundry_root, present, extra)
    return linked, paths, _era_label(forge_std, canonical.values()), can_step


def _verify_repo_mode(forge, poc_source, setup, foundry_root):
    """Run the PoC inside the session's repo copy with the repo's own
    build setup; the original repo is never touched (see driver.ts).

    Compile-fallback: an error verdict whose forge output matches a dep
    version-mismatch signature retries ONCE with every dep stepped one
    era older (pragmas can't express v4-vs-v5 API differences)."""
    _l, _p, era, can_step = _symlink_std_libs(foundry_root, poc_source)
    for rel, source in (setup.get("files") or {}).items():
        dest = os.path.realpath(os.path.join(foundry_root, rel))
        if not dest.startswith(foundry_root + os.sep):
            raise ValueError(f"setup file path escapes foundry root: {rel!r}")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w") as f:
            f.write(source)
    poc_dir = os.path.join(foundry_root, "test", "attis_poc")
    slug = re.sub(r"[^A-Za-z0-9_-]", "", setup.get("slug") or "") or "Poc"
    os.makedirs(poc_dir, exist_ok=True)
    match_path = f"test/attis_poc/{slug}.t.sol"
    with open(os.path.join(poc_dir, f"{slug}.t.sol"), "w") as f:
        f.write(poc_source)
    try:
        output = _run_forge(forge, match_path, foundry_root, setup)
        if (can_step and _parse_verdict(output) == "error"
                and _is_compile_mismatch(output)):
            _l, _p, era, _c = _symlink_std_libs(foundry_root, poc_source, step_down=True)
            output = _run_forge(forge, match_path, foundry_root, setup)
    finally:
        # The PoC never outlives its run — the copy must stay diff-clean
        # for the audit trail (lib/ symlinks stay; they are idempotent).
        shutil.rmtree(poc_dir, ignore_errors=True)
    runs_dir = os.path.join(CTX["scratch_dir"], RUNS_SUBDIR)
    os.makedirs(runs_dir, exist_ok=True)
    log_path = os.path.join(runs_dir, f"forge-output-{int(time.time() * 1000)}.log")
    with open(log_path, "w") as f:
        f.write(output)
    return output, log_path, era


def _verify_template_mode(forge, poc_source, setup, step_down=False):
    """Bare template workspace + the repo's .sol tree staged under
    src/repo/ + remappings into the deps cache. forge-std is era-picked
    from the staged sources (pre-0.8.13 repos get forge-std-legacy).
    step_down=True is the compile-fallback retry (one era older).
    Returns (output, log_path, era, can_step_down)."""
    run_dir = _materialize(poc_source, setup.get("files"))
    _stage_repo_sources(run_dir)
    deps = _deps()
    wanted = _referenced_std_libs(poc_source)
    texts = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(run_dir, "src", "repo")):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".sol"):
                try:
                    with open(os.path.join(dirpath, fn), errors="replace") as f:
                        texts.append(f.read())
                except OSError:
                    pass
    wanted = sorted(set(wanted) | set(_referenced_std_libs("\n".join(texts))))
    lower, upper = deps.repo_solc_bounds(texts)
    forge_std = deps.pick_dep("forge-std", upper, lower)
    # canonical lib name -> era-picked cache name (identity for most).
    canonical = {n: deps.pick_dep(n, upper, lower) for n in wanted}
    can_step = _can_step_down(forge_std, canonical.values())
    if step_down:
        forge_std, canonical = _step_down_eras(forge_std, canonical)
    ensure_names = sorted(set(canonical.values()) | {forge_std})
    dep_paths = deps.ensure(ensure_names)
    alias_base = _alias_target(deps, texts + [poc_source],
                               dep_paths.get(canonical.get(
                                   "openzeppelin-contracts-upgradeable", "")))
    _write_remappings(run_dir, dep_paths, forge_std, canonical, alias_base)
    output = _run_forge(forge, "test/Poc.t.sol", run_dir, setup)
    log_path = os.path.join(run_dir, "forge-output.log")
    with open(log_path, "w") as f:
        f.write(output)
    return output, log_path, _era_label(forge_std, canonical.values()), can_step


def verify(poc_source, setup=None):
    """Write a PoC into a forge workspace, run `forge test`, parse output.

    setup (optional): {
        "rpc_url": run against this anvil (default: current chain, if any),
        "files":   {relpath: source} extra contracts (e.g. the target),
        "timeout_s": forge timeout (default 180),
        "foundry_root": repo-relative override for the project dir (repo
            mode runs even when detection misses a nested layout),
        "slug": PoC file name in repo mode (default "Poc"),
    }

    Returns {"verdict": "verified" | "reverted" | "error",
             "mode": "repo" | "template",
             "era": "latest" | "v4" | "legacy" (dep era actually used),
             "state_diff": {...best-effort...},
             "traces_summary": str, "raw_log_path": str,
             "missing_import": str (error verdicts, when parseable)}.

    state_diff note: forge test does not emit structured state diffs, so
    this is populated best-effort from `vm.getRecordedLogs`-style output
    when present and otherwise left empty — strict verification should
    read balances/storage via fork.rpc() before and after (that is the
    pattern the audit loop uses).
    """
    setup = setup or {}
    # Resolve the repo-mode target first so an invalid override raises
    # regardless of whether forge is installed.
    foundry_root = _resolve_foundry_override(setup)
    forge = shutil.which("forge")
    if not forge:
        return _emit_verdict({"verdict": "error", "state_diff": {}, "traces_summary": "",
                              "raw_log_path": None, "mode": None,
                              "error": "forge not found on PATH (install foundryup)"})
    if not foundry_root and CTX.get("repo_root"):
        foundry_root = find_foundry_root(CTX["repo_root"])
    if foundry_root:
        mode = "repo"
        output, log_path, era = _verify_repo_mode(forge, poc_source, setup, foundry_root)
    else:
        mode = "template"
        output, log_path, era, can_step = _verify_template_mode(forge, poc_source, setup)
        if (can_step and _parse_verdict(output) == "error"
                and _is_compile_mismatch(output)):
            output, log_path, era, _c = _verify_template_mode(
                forge, poc_source, setup, step_down=True)
    v = _verdict_from(output, mode, log_path, era)
    v["raw_log_path"] = _durable_log(log_path, mode)
    return _emit_verdict(v)
