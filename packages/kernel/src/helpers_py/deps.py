"""deps helper — shared shallow-clone cache of common forge libraries.

GitHub tarballs strip git submodules, so audited repos almost always
arrive without lib/forge-std & co. This cache (~/.attis/deps/<name>) holds
one shallow clone per well-known library; fork.verify symlinks/remaps them
into the session workspace instead of cloning per session.

Era-aware: forge-std exists in two variants — `forge-std` (latest,
requires solc >=0.8.13) and `forge-std-legacy` (v1.5.6 tag, pragma
>=0.6.2 <0.9.0) for 2021-2022 repos whose pinned pragmas no modern solc
can satisfy alongside latest forge-std. pick_forge_std() scans the repo's
pragma ranges and chooses.

Stdlib only; git via subprocess (trusted helper code). ensure() is
offline-graceful: a failed clone never raises — the dep is simply reported
as None so the caller can degrade (error verdict with a hint) instead of
killing the audit session.

API: ensure(names=None, cache_dir=None, runner=None) -> {name: path|None}
     available(name, cache_dir=None) -> path|None
     pragma_upper_bound(source) -> ((major, minor, patch), inclusive) | None
     pick_forge_std(sources) -> "forge-std" | "forge-std-legacy"
"""
import contextlib
import os
import re
import shutil
import subprocess

CTX = None

# name -> {"url", "branch"?}. The name is also the lib/ dir forge expects
# (forge-std-legacy is never lib-linked under its own name — fork.py links
# it as lib/forge-std when era detection picks it).
DEPS = {
    "forge-std": {"url": "https://github.com/foundry-rs/forge-std"},
    # v1.5.6: last release whose pragma (>=0.6.2 <0.9.0) pre-0.8.13 repos
    # can satisfy. Latest master requires >=0.8.13. Its Test.sol imports
    # ds-test (its only submodule), so the clone must recurse — and the
    # marker lets a stale submodule-less copy be re-cloned.
    "forge-std-legacy": {"url": "https://github.com/foundry-rs/forge-std",
                         "branch": "v1.5.6",
                         "recurse_submodules": True,
                         "marker": "lib/ds-test/src"},
    "openzeppelin-contracts": {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts"},
    # Contracts live under contracts/ and the package expects plain
    # openzeppelin-contracts as a sibling (its own foundry setup remaps
    # @openzeppelin/contracts to it) — fork.py provisions both together.
    "openzeppelin-contracts-upgradeable":
        {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable"},
    "solmate": {"url": "https://github.com/transmissions11/solmate"},
    "solady": {"url": "https://github.com/Vectorized/solady"},
}

# Latest forge-std requires solc >= 0.8.13 — repos capped below get legacy.
FORGE_STD_LATEST_MIN = (0, 8, 13)

PRAGMA_RE = re.compile(r"pragma\s+solidity\s+([^;]+);")
CLAUSE_RE = re.compile(r"(<=|>=|<|>|=|\^)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?")


def configure(ctx):
    global CTX
    CTX = ctx


def default_cache_dir():
    """ATTIS_DEPS_DIR overrides (tests, sandboxed runs); else ~/.attis/deps."""
    return os.environ.get("ATTIS_DEPS_DIR") or os.path.expanduser("~/.attis/deps")


def _present(path):
    return os.path.isdir(path) and bool(os.listdir(path))


def available(name, cache_dir=None):
    """Path of a cached dep, or None when absent."""
    dest = os.path.join(cache_dir or default_cache_dir(), name)
    return dest if _present(dest) else None


@contextlib.contextmanager
def _file_lock(cache):
    """Advisory lock against concurrent kernels cloning the same dep.

    Best-effort: platforms without fcntl just skip the lock (the clone is
    idempotent — worst case is a wasted parallel clone, never corruption,
    because the dep lands via os.replace from a temp dir).
    """
    try:
        import fcntl
    except ImportError:
        yield
        return
    os.makedirs(cache, exist_ok=True)
    with open(os.path.join(cache, ".lock"), "w") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def ensure(names=None, cache_dir=None, runner=None, timeout_s=180):
    """Make the named deps available locally; return {name: path|None}.

    Clones `--depth 1` when absent. Never raises on clone failure (offline,
    no git, flaky network): the dep maps to None. `runner` is injectable for
    tests — same signature as subprocess.run.
    """
    runner = runner or subprocess.run
    names = list(names) if names else list(DEPS)
    cache = cache_dir or default_cache_dir()
    result = {}
    with _file_lock(cache):
        for name in names:
            dep = DEPS.get(name)
            if dep is None:
                raise ValueError(f"unknown dep: {name!r} (known: {sorted(DEPS)})")
            dest = os.path.join(cache, name)
            marker = dep.get("marker")
            if _present(dest) and (not marker or os.path.exists(os.path.join(dest, marker))):
                result[name] = dest
                continue
            # Absent, or stale (marker missing — e.g. cloned before the dep
            # grew submodules): re-clone from scratch.
            shutil.rmtree(dest, ignore_errors=True)
            staging = dest + ".staging"
            shutil.rmtree(staging, ignore_errors=True)
            args = ["git", "clone", "--depth", "1"]
            if dep.get("branch"):
                args += ["--branch", dep["branch"]]
            if dep.get("recurse_submodules"):
                args += ["--recurse-submodules", "--shallow-submodules"]
            args += [dep["url"], staging]
            try:
                proc = runner(args, capture_output=True, text=True, timeout=timeout_s)
                ok = getattr(proc, "returncode", 1) == 0
            except Exception:
                ok = False
            if ok and _present(staging) and (
                    not marker or os.path.exists(os.path.join(staging, marker))):
                os.replace(staging, dest)
                result[name] = dest
            else:
                shutil.rmtree(staging, ignore_errors=True)
                result[name] = None
    return result


def _version(major, minor, patch):
    return (int(major), int(minor or 0), int(patch or 0))


def _range_upper(expr):
    """Upper bound of one pragma range expression, as ((m, n, p), inclusive)
    or None when unbounded. Styles: =0.8.4 / bare 0.8.4 (exact), ^0.8.0
    (semver caret), >=0.8.0 <0.9.0 (clauses), >=0.5.0 (no upper)."""
    best = None
    for op, major, minor, patch in CLAUSE_RE.findall(expr):
        v = _version(major, minor, patch)
        if op in ("=", "") or op is None:
            cand = (v, True)
        elif op == "^":
            # ^0.8.0 := >=0.8.0 <0.9.0; ^0.0.x pins the patch (rare in the
            # wild, but semver says <0.1.0).
            cand = ((0, v[1] + 1, 0), False) if v[0] == 0 else ((v[0] + 1, 0, 0), False)
        elif op == "<":
            cand = (v, False)
        elif op == "<=":
            cand = (v, True)
        else:  # >, >= — lower bounds only
            continue
        if best is None or _upper_lt(cand, best):
            best = cand
    return best


def _upper_lt(a, b):
    """(version, inclusive) ordering: tighter bound wins."""
    return a[0] < b[0] or (a[0] == b[0] and not a[1] and b[1])


def pragma_upper_bound(source):
    """Tightest upper solc bound across a source's `pragma solidity` lines,
    or None when no pragma (or no bounded range) is present."""
    best = None
    for m in PRAGMA_RE.finditer(source or ""):
        ub = _range_upper(m.group(1))
        if ub and (best is None or _upper_lt(ub, best)):
            best = ub
    return best


def pick_forge_std(sources):
    """Choose the forge-std variant for a repo: "forge-std-legacy" when the
    repo's max satisfiable solc is below 0.8.13 (latest forge-std's floor),
    else "forge-std".

    `sources` is an iterable of source strings or .sol file paths (paths
    are read; unreadable/missing entries are skipped). Files without a
    pragma carry no bound — with no bounded pragma at all, default to
    latest (forge picks the newest solc). The tightest bound across files
    decides, because forge compiles the whole unit with one solc.

    The PoC's own pragma is deliberately NOT part of `sources` — it comes
    from the model (usually ^0.8.x) and is compatible with either variant.
    """
    upper = None
    for item in sources or []:
        if not isinstance(item, str):
            continue
        text = item
        if os.path.isfile(item):
            try:
                with open(item, errors="replace") as f:
                    text = f.read()
            except OSError:
                continue
        ub = pragma_upper_bound(text)
        if ub and (upper is None or _upper_lt(ub, upper)):
            upper = ub
    if upper is None:
        return "forge-std"
    version, inclusive = upper
    capped_below = (version < FORGE_STD_LATEST_MIN
                    or (version == FORGE_STD_LATEST_MIN and not inclusive))
    return "forge-std-legacy" if capped_below else "forge-std"
