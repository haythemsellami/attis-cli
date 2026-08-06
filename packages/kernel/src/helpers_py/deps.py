"""deps helper — shared shallow-clone cache of common forge libraries.

GitHub tarballs strip git submodules, so audited repos almost always
arrive without lib/forge-std & co. This cache (~/.attis/deps/<name>) holds
one shallow clone per well-known library; fork.verify symlinks/remaps them
into the session workspace instead of cloning per session.

Stdlib only; git via subprocess (trusted helper code). ensure() is
offline-graceful: a failed clone never raises — the dep is simply reported
as None so the caller can degrade (error verdict with a hint) instead of
killing the audit session.

API: ensure(names=None, cache_dir=None, runner=None) -> {name: path|None}
     available(name, cache_dir=None) -> path|None
"""
import contextlib
import os
import shutil
import subprocess

CTX = None

# name -> clone url. The name is also the lib/ dir forge expects.
DEPS = {
    "forge-std": "https://github.com/foundry-rs/forge-std",
    "openzeppelin-contracts": "https://github.com/OpenZeppelin/openzeppelin-contracts",
    "solmate": "https://github.com/transmissions11/solmate",
    "solady": "https://github.com/Vectorized/solady",
}


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
            url = DEPS.get(name)
            if url is None:
                raise ValueError(f"unknown dep: {name!r} (known: {sorted(DEPS)})")
            dest = os.path.join(cache, name)
            if _present(dest):
                result[name] = dest
                continue
            staging = dest + ".staging"
            shutil.rmtree(staging, ignore_errors=True)
            try:
                proc = runner(["git", "clone", "--depth", "1", url, staging],
                              capture_output=True, text=True, timeout=timeout_s)
                ok = getattr(proc, "returncode", 1) == 0
            except Exception:
                ok = False
            if ok and _present(staging):
                os.replace(staging, dest)
                result[name] = dest
            else:
                shutil.rmtree(staging, ignore_errors=True)
                result[name] = None
    return result
