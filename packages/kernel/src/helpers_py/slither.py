"""slither helper — static analysis over the mounted repo.

Degrades cleanly: when the slither CLI is absent, scan() returns
{"ok": False, "error": ...} instead of raising, so the model can fall
back to manual review. Findings feed the rollout's region ranking
(roadmap item 6).
"""
import json
import os
import shutil
import subprocess
import tempfile

CTX = None


def configure(ctx):
    global CTX
    CTX = ctx


def _resolve(path):
    """Same confinement rule as the repo helper: stay under the repo root."""
    root = os.path.realpath(CTX["repo_root"])
    full = os.path.realpath(os.path.join(root, path))
    if full != root and not full.startswith(root + os.sep):
        raise ValueError(f"path escapes repo root: {path!r}")
    return full


def scan(path=None, timeout_s=180, max_detectors=200):
    """Run slither on the repo (or a repo-relative path), return findings.

    Returns {"ok": bool, "findings": [{check, impact, confidence,
    description}], "count": int, "raw_path": str|None, "error": str?}.
    """
    slither = shutil.which("slither")
    if not slither:
        return {"ok": False, "findings": [], "count": 0, "raw_path": None,
                "error": "slither not found on PATH — static scan unavailable; "
                         "continue with manual review (slither-analyzer not installed)"}
    target = _resolve(path) if path else os.path.realpath(CTX["repo_root"])
    out_dir = tempfile.mkdtemp(prefix="slither-", dir=CTX["scratch_dir"])
    out_json = os.path.join(out_dir, "slither.json")
    try:
        proc = subprocess.run(
            [slither, target, "--json", out_json],
            capture_output=True, text=True, timeout=timeout_s,
            cwd=CTX["scratch_dir"],
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "findings": [], "count": 0, "raw_path": None,
                "error": f"slither timed out after {timeout_s}s"}
    if not os.path.exists(out_json):
        tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-2000:]
        return {"ok": False, "findings": [], "count": 0, "raw_path": None,
                "error": f"slither produced no JSON (compile failure?):\n{tail}"}
    with open(out_json) as f:
        data = json.load(f)
    detectors = (data.get("results") or {}).get("detectors") or []
    findings = [
        {
            "check": d.get("check"),
            "impact": d.get("impact"),
            "confidence": d.get("confidence"),
            "description": (d.get("description") or "")[:500],
        }
        for d in detectors[:max_detectors]
    ]
    return {"ok": True, "findings": findings, "count": len(detectors),
            "raw_path": out_json}
