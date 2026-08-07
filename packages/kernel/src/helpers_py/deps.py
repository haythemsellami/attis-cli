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
     pragma_upper_bound(source) / pragma_lower_bound(source)
         -> ((major, minor, patch), inclusive) | None
     repo_solc_bounds(sources) -> (lower, upper)
     pick_dep(name, upper_bound, lower_bound=None) -> deps-cache name
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
    # Era variants (path layouts differ per major: v3 has contracts/math/,
    # v4 moved to contracts/utils/math/, v5 deleted SafeMath & co — the
    # right tag makes old import paths resolve; no path rewriting).
    "openzeppelin-contracts-legacy": {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts",
                                      "branch": "v3.4.2"},
    "openzeppelin-contracts-v4": {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts",
                                  "branch": "v4.9.6"},
    # Contracts live under contracts/ and the package expects plain
    # openzeppelin-contracts as a sibling (its own foundry setup remaps
    # @openzeppelin/contracts to it) — fork.py provisions both together.
    "openzeppelin-contracts-upgradeable":
        {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable"},
    "openzeppelin-contracts-upgradeable-legacy":
        {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable",
         "branch": "v3.4.2"},
    "openzeppelin-contracts-upgradeable-v4":
        {"url": "https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable",
         "branch": "v4.9.6"},
    # The 2021 hardhat-era @openzeppelin/upgrades npm package (max 2.8.0)
    # IS this old sdk package — ROOT-level contracts (contracts/
    # Initializable.sol), a layout the upgradeable package never shipped.
    # fork.py's alias probe maps @openzeppelin/upgrades/ imports here when
    # the era-picked upgradeable cache doesn't carry the referenced path.
    "openzeppelin-upgrades-legacy": {"url": "https://github.com/OpenZeppelin/openzeppelin-sdk",
                                     "branch": "v2.8.2"},
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


def _upper_lt(a, b):
    """(version, inclusive) ordering: tighter (smaller) upper bound wins."""
    return a[0] < b[0] or (a[0] == b[0] and not a[1] and b[1])


def _lower_gt(a, b):
    """(version, inclusive) ordering: tighter (larger) lower bound wins."""
    return a[0] > b[0] or (a[0] == b[0] and not a[1] and b[1])


def _range_bounds(expr):
    """(lower, upper) bounds of one pragma range expression, each
    ((m, n, p), inclusive) or None when unbounded. Styles: =0.8.4 / bare
    0.8.4 (exact), ^0.8.0 (semver caret), >=0.8.0 <0.9.0 (clauses),
    >=0.5.0 (no upper)."""
    lower = upper = None
    for op, major, minor, patch in CLAUSE_RE.findall(expr):
        v = _version(major, minor, patch)
        lo = hi = None
        if op in ("=", "") or op is None:
            lo = hi = (v, True)
        elif op == "^":
            # ^0.8.0 := >=0.8.0 <0.9.0; ^0.0.x pins the patch (rare in the
            # wild, but semver says <0.1.0).
            lo = (v, True)
            hi = ((0, v[1] + 1, 0), False) if v[0] == 0 else ((v[0] + 1, 0, 0), False)
        elif op == ">=":
            lo = (v, True)
        elif op == ">":
            lo = (v, False)
        elif op == "<":
            hi = (v, False)
        elif op == "<=":
            hi = (v, True)
        if lo and (lower is None or _lower_gt(lo, lower)):
            lower = lo
        if hi and (upper is None or _upper_lt(hi, upper)):
            upper = hi
    return lower, upper


def pragma_upper_bound(source):
    """Tightest upper solc bound across a source's `pragma solidity` lines,
    or None when no pragma (or no bounded range) is present."""
    best = None
    for m in PRAGMA_RE.finditer(source or ""):
        ub = _range_bounds(m.group(1))[1]
        if ub and (best is None or _upper_lt(ub, best)):
            best = ub
    return best


def pragma_lower_bound(source):
    """Tightest lower solc bound across a source's `pragma solidity` lines,
    or None when no pragma (or no lower-bounded range) is present."""
    best = None
    for m in PRAGMA_RE.finditer(source or ""):
        lb = _range_bounds(m.group(1))[0]
        if lb and (best is None or _lower_gt(lb, best)):
            best = lb
    return best


def _read_sources(sources):
    """Iterate source texts; entries that are existing files are read."""
    for item in sources or []:
        if not isinstance(item, str):
            continue
        if os.path.isfile(item):
            try:
                with open(item, errors="replace") as f:
                    yield f.read()
            except OSError:
                continue
        else:
            yield item


def repo_solc_bounds(sources):
    """(lower, upper) solc bounds for a repo's sources: the tightest bound
    of each kind across files (forge compiles the unit with one solc, so
    any capped file caps the repo). `sources` entries are source strings
    or .sol file paths; files without a pragma carry no bound.

    The PoC's own pragma is deliberately NOT part of `sources` — it comes
    from the model (usually ^0.8.x) and is compatible with any variant."""
    lower = upper = None
    for text in _read_sources(sources):
        lb = pragma_lower_bound(text)
        if lb and (lower is None or _lower_gt(lb, lower)):
            lower = lb
        ub = pragma_upper_bound(text)
        if ub and (upper is None or _upper_lt(ub, upper)):
            upper = ub
    return lower, upper


def _bound_below(bound, version):
    """True when the bound caps satisfiable solc strictly below `version`."""
    v, inclusive = bound
    return v < version or (v == version and not inclusive)


# Era variants for OpenZeppelin: canonical name -> (legacy tag, v4 tag).
OZ_VARIANTS = {
    "openzeppelin-contracts": ("openzeppelin-contracts-legacy",
                               "openzeppelin-contracts-v4"),
    "openzeppelin-contracts-upgradeable": ("openzeppelin-contracts-upgradeable-legacy",
                                           "openzeppelin-contracts-upgradeable-v4"),
}


def pick_dep(name, upper_bound, lower_bound=None):
    """Era-pick the deps-cache variant for a canonical lib name.

    Era bound = the upper bound when bounded, else the declared minimum
    (a `>=0.6.6` repo was authored against 0.6.x-era packages — its
    imports only resolve against era-matching tags, and its compile graph
    cannot mix pre-0.8 deps with deps requiring >=0.8.13).

    forge-std: era < 0.8.13 (latest forge-std's floor) → forge-std-legacy;
        no bounds at all → latest.
    openzeppelin-contracts[/ -upgradeable]: era < 0.8.0 → legacy (v3.4.2,
        ships contracts/math/); [0.8.0, 0.8.20) → v4 (v4.9.6, utils/math/);
        >= 0.8.20 or no bounds → latest.
    Anything else (solmate, solady, ...): returned unchanged.
    """
    era = upper_bound or lower_bound
    if name == "forge-std":
        if era and _bound_below(era, FORGE_STD_LATEST_MIN):
            return "forge-std-legacy"
        return "forge-std"
    variants = OZ_VARIANTS.get(name)
    if variants:
        if era is None:
            return name
        if _bound_below(era, (0, 8, 0)):
            return variants[0]
        if _bound_below(era, (0, 8, 20)):
            return variants[1]
        return name
    return name


def pick_forge_std(sources):
    """Choose the forge-std variant for a repo: "forge-std-legacy" when the
    repo's max satisfiable solc is below 0.8.13 (latest forge-std's floor),
    else "forge-std". Thin wrapper over repo_solc_bounds + pick_dep —
    see those for the source/semantics contract."""
    return pick_dep("forge-std", repo_solc_bounds(sources)[1])
