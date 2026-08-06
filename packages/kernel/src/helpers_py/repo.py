"""repo helper — read-only view of the mounted repo.

The kernel mounts the driver's per-session COPY of the audited repo
(originals are never touched, see driver.ts). Reads are confined to the
repo root: any path that resolves outside it is rejected (symlinks
included, via realpath).

API: tree(), read(path, max_chars=...)
"""
import os
import re

CTX = None

IMPORT_RE = re.compile(r"""^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']""", re.M)

# Directories that carry no audit signal (VCS metadata, deps, build output).
SKIP_DIRS = {".git", "node_modules", "out", "cache", "broadcast", "lib", "artifacts"}


def configure(ctx):
    global CTX
    CTX = ctx


def _root():
    return os.path.realpath(CTX["repo_root"])


def resolve(path):
    """Resolve a repo-relative path, rejecting anything outside the root."""
    full = os.path.realpath(os.path.join(_root(), path))
    root = _root()
    if full != root and not full.startswith(root + os.sep):
        raise ValueError(f"path escapes repo root: {path!r}")
    return full


def read(path, max_chars=100_000):
    """Read a repo file (path-traversal-safe, read-only)."""
    full = resolve(path)
    if not os.path.isfile(full):
        raise FileNotFoundError(f"no such file in repo: {path!r}")
    with open(full, "r", errors="replace") as f:
        data = f.read(max_chars + 1)
    if len(data) > max_chars:
        data = data[:max_chars] + "\n... <truncated>"
    return data


def tree():
    """File listing + Solidity import graph of the mounted repo.

    Returns {"files": [...repo-relative paths...],
             "imports": {sol_file: [import specifiers as written]}}.
    """
    root = _root()
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for fn in sorted(filenames):
            files.append(os.path.relpath(os.path.join(dirpath, fn), root))
    imports = {}
    for rel in files:
        if rel.endswith(".sol"):
            try:
                deps = IMPORT_RE.findall(read(rel))
            except Exception:
                continue
            if deps:
                imports[rel] = deps
    return {"files": files, "imports": imports}
