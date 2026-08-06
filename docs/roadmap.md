# attis-cli Roadmap — Milestone v2

> **Scope rule:** this document covers ONLY the current milestone. v1 is
> complete (see Done-when, all met 2026-07-30). Before any work on v3, this
> file must be rewritten first. The spec (`docs/spec.md`) is the contract;
> `docs/vision-versions.md` is the milestone map.

**Milestone v2:** make attis-cli the rollout environment for Orgia — the
machine that (a) drives the model with code execution over real repos,
(b) verifies findings on forks at throughput, and (c) exports every session
as training data for orgia-llm v8 (the flywheel + the RLVR reward
foundation).

Context anchors (from orgia-llm iterations 8–10): the model is
fragment-elite and whole-file-weak; it folds at contract boundaries;
fabrication exists on safe code. The harness answers with: a persistent
audit kernel over the fork substrate, fork-gated precision, and trace
export.

## Work items (in order)

### 1. Tool-call reliability smoke — DONE, verdict recorded (2026-08)

Smoke ran against the fine-tuned 9B adapter: **0/30 schema-valid native
tool calls** (30/30 answered in prose). Narrow SFT catastrophically forgot
the base model's tool-calling prior — the known small-LoRA disease, not a
serving bug.

**Verdict (revised after the code-mode design review):** the runtime wire
is **native OpenAI function calling end to end — no marker fallback.**
The forgetting is fixed at the source: orgia v8 trains a code-mode trace
mix (10–15% of the dataset, native wire). The circular dependency
(rollouts need traces; traces need a capable model) is bridged by a
**teacher**: bootstrap rollouts are driven by the base Qwen3.5-9B (prior
intact) or deepseek-v4-pro, emitting the exact native format v8 trains on.
v8 pre-flight (orgia side): chat-template round-trip test + post-train
smoke, target >95% schema-valid native calls.

### 2. `execute_code` + audit kernel — `packages/core/tools/`, `packages/kernel/`

The one model-facing tool: `execute_code`, a **persistent IPython kernel**
per audit session (prime-agent's RLM shape). The kernel boots with the
**audit helper library** — `fork.*`, `slither.*`, `repo.*`,
`snapshot/revert` — over the fork substrate (foundry + anvil pool inside
the execution environment). Helper library is **minimal now, built for
extension**: plain modules registered at kernel bootstrap; rollout
evidence, not speculation, decides what gets added. Scope discovery
(`repo.tree()` inventory: file list, imports graph) lets the model know
what exists.

Executor behind a **driver interface** (same pattern as serving-manager):
`local` driver first — non-root, per-session tmp copy of the repo, hard
timeouts, network locked to the RPC proxy. `docker` driver deferred
(triggers: fleet scale, untrusted code, hermetic eval reproducibility).

*Acceptance:* on a multi-file fixture (vault + oracle), the teacher model
requests the dependency via kernel code mid-audit and its finding cites
the interaction; every execution journaled; execpolicy blocks forbidden
commands (verified: `cast send --private-key`, `curl`).

### 3. Rollout mode — `bin/attis rollout <repo-dir>`

Batch driver: for each repo (scabench tarball set, C4 repos), run the
audit loop with the kernel enabled, journal everything. **Bootstrap
rollouts are teacher-driven** (base Qwen3.5-9B or deepseek-v4-pro) — the
v7.x adapters can't emit native calls (item 1); post-v8, Orgia takes over.
Sequential per repo, resumable, journal-first.

*Acceptance:* one full repo rollout completes with native tool calls +
fork verdicts journaled; the trace file exports to orgia-llm's
training-row format (see item 5) without loss.

### 4. Serving-manager — `packages/serving/`

Driver interface `start() / health() / stop()` with three drivers:
`env` (current), `local` (vllm subprocess), `runpod` (pod lifecycle +
SSH tunnel + **guaranteed stop on exit** — the golden rule by construction).

*Acceptance:* `attis audit --pod` runs a full session against a pod and the
pod is stopped when the CLI exits (verified with a kill -9 test).

### 5. Journal → training-row exporter — `packages/journal/export.ts`

Maps journal entries to orgia-llm training rows: (prompt, `execute_code`
calls, results, analysis, finding, fork verdict) → ShareGPT rows in the
**native OpenAI function-calling wire** — no conversion layer, the journal
already records the canonical format. Verified findings → gold positives;
failed verifications → hard negatives. The flywheel contract.

*Acceptance:* a rollout session's journal exports a valid training row
loadable by orgia-llm's pipeline (schema-compatible with train.jsonl).

### 6. judge / score tools (harness-side, spec §6 registry)

`score_finding` (custom scorer, port/wrap from Python) and `judge_semantic`
(DeepSeek; asks — network). These are harness-side services, not
model-facing tools; they feed repo-scale ranking in v3. `slither` lives in
the kernel as a helper (`slither.scan()`), its findings feed the rollout's
region ranking.

*Acceptance:* slither findings feed into the rollout's region ranking;
judge calls are gated and journaled.

## Done-when (v2 exit criteria)

1. Tool-call smoke verdict recorded (**met**: 0/30 → native wire kept,
   v8 trace mix + teacher bootstrap is the fix)
2. A teacher-driven repo rollout with kernel execution completes
   end-to-end, journaled
3. The journal exports a schema-valid orgia-llm training row (native wire)
4. `--pod` mode runs + stops the pod automatically (no stray billing)
5. `pnpm test` + `pnpm typecheck` green

## Explicitly NOT in v2

- TUI (v3), MCP servers (v3), repo-scale decomposition ranking (v3),
  RLVR training loop (orgia v8+), RAG over exploit corpus (v4),
  `docker` executor driver (v3+, trigger-gated)
