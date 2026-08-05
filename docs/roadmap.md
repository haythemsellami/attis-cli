# attis-cli Roadmap — Milestone v2

> **Scope rule:** this document covers ONLY the current milestone. v1 is
> complete (see Done-when, all met 2026-07-30). Before any work on v3, this
> file must be rewritten first. The spec (`docs/spec.md`) is the contract;
> `docs/vision-versions.md` is the milestone map.

**Milestone v2:** make attis-cli the rollout environment for Orgia — the
machine that (a) drives the model with real tools over real repos, (b)
verifies findings on forks at throughput, and (c) exports every session as
training data for orgia-llm v8 (the flywheel + the RLVR reward foundation).

Context anchors (from orgia-llm iterations 8–10): the model is fragment-elite
and whole-file-weak; it folds at contract boundaries; fabrication exists on
safe code. The harness answers with: dependency-pursuit tools, fork-gated
precision, and trace export.

## Work items (in order)

### 1. Tool-call reliability smoke (decides the output contract)

Before building tool-driven flows: verify the fine-tuned 9B drives native
tool calls reliably (LoRAs never saw tool schemas). Serve an adapter, prompt
with a fetch tool schema, measure call validity/argument quality across ~50
prompts.

*Acceptance:* >95% schema-valid tool calls, or we fall back to structured
text markers ("I need file X") parsed deterministically. Recorded verdict
informs items 2 and 4.

### 2. `fetch_dependency` / repo-read tool — `packages/core/tools/`

The scope-expansion tool: the model requests a file it can't see (import,
interface, proxy target), the harness returns it from the mounted repo.
Includes scope discovery (`audit_repo` inventory: file list, imports graph).

*Acceptance:* on a multi-file fixture (vault + oracle), the model requests
the dependency mid-audit and its finding cites the interaction; tool is
read-only, auto-approved, journaled.

### 3. Rollout mode — `bin/attis rollout <repo-dir>`

Batch driver: for each repo (scabench tarball set, C4 repos), run the audit
loop with tools enabled, journal everything. This produces the tool-use
traces orgia v8 trains on. Sequential per repo, resumable, journal-first.

*Acceptance:* one full repo rollout completes with tool calls + fork
verdicts journaled; the trace file exports to orgia-llm's training-row
format (see item 5) without loss.

### 4. Serving-manager — `packages/serving/`

Driver interface `start() / health() / stop()` with three drivers:
`env` (current), `local` (vllm subprocess), `runpod` (pod lifecycle +
SSH tunnel + **guaranteed stop on exit** — the golden rule by construction).

*Acceptance:* `attis audit --pod` runs a full session against a pod and the
pod is stopped when the CLI exits (verified with a kill -9 test).

### 5. Journal → training-row exporter — `packages/journal/export.ts`

Maps journal entries to orgia-llm training rows: (prompt, tool calls,
analysis, finding, fork verdict) → ShareGPT rows with tool-call structure;
verified findings → gold positives; failed verifications → hard negatives.
The flywheel contract.

*Acceptance:* the v1 fixture session's journal exports a valid training row
loadable by orgia-llm's pipeline (schema-compatible with train.jsonl).

### 6. slither / score / judge tools (spec §6 registry)

`slither_scan` (static triage, auto-approved read), `score_finding`,
`judge_semantic` (DeepSeek; asks — network). These round out the registry
v1 and feed repo-scale ranking in v3.

*Acceptance:* slither findings feed into the rollout's region ranking;
judge calls are gated and journaled.

## Done-when (v2 exit criteria)

1. Tool-call smoke verdict recorded (native tool calls or text-marker fallback)
2. A repo rollout with dependency pursuit completes end-to-end, journaled
3. The journal exports a schema-valid orgia-llm training row
4. `--pod` mode runs + stops the pod automatically (no stray billing)
5. `pnpm test` + `pnpm typecheck` green

## Explicitly NOT in v2

- TUI (v3), MCP servers (v3), repo-scale decomposition ranking (v3),
  RLVR training loop (orgia v8+), RAG over exploit corpus (v4)
