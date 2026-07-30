# attis-cli Roadmap — Milestone v1 ✅ COMPLETE (2026-07-30)

> **Scope rule:** this document covers ONLY the current milestone. Before any
> work starts on the NEXT milestone, this file must be updated first — the
> next milestone's roadmap is written then, informed by what this one taught
> us. The spec (`docs/spec.md`) is the contract; this file is the ordered how.
>
> **v1 status: COMPLETE.** All exit criteria met (see Done-when). Output
> contract decision: (a) prose-contract parsing for findings now; (b)
> tool-call findings smoke test deferred to v2 (see `docs/vision-versions.md`).

**Milestone v1 (spec §14.2):** the full loop on per-contract input —
`audit → hypothesize → PoC → fork-verify → report`. Only fork-verified
findings ship (spec principle 1). Done means: `attis audit <contract.sol>`
produces a report containing *verified* findings end-to-end, with every step
journaled.

## Environment prerequisites

- `forge` + `anvil` (foundry) on PATH
- `ALCHEMY_API_KEY` (or `ATTIS_RPC_URL`) in env for fork endpoints
- A serving endpoint: local vLLM subprocess or pod-mode (milestone v2 concern;
  v1 uses the env-configured endpoint from the spike)

## Work items (in order)

### 1. Findings parser (TS) — `packages/core/findings.ts`

Port of orgia-llm's `parse_model_output` semantics to TypeScript: model
output → typed `Finding[]` (severity, title, impact, poc, remediation) +
safe-verdict detection. Strict mode fails loudly on non-conforming output.

*Acceptance:* unit tests pass on real v7 eval outputs (structured, multi-
finding, safe, and adversarial/malformed samples); zero regex-only guesses —
a finding either parses fully or is flagged unparseable.

### 2. `generate_poc` tool (exploit mode) — `packages/core/tools/generate-poc.ts`

Invokes the model with the **trained exploit-mode system prompt** (ported
from orgia-llm `system_prompt.py`), given a finding + the contract code.
Not a generic "write an exploit" prompt — the model's own trained format.

*Acceptance:* produces a PoC in the trained exploit format for the fixture
reentrancy; registered in the tool registry, `llm` type, auto-approved.

### 3. Fork layer — `packages/fork/`

- anvil process manager: spawn `anvil --fork-url $RPC_URL [--fork-block-number N]`,
  health-check, kill on exit, **restart-on-death** (spec §5 ForkDied handler)
- forge runner: materialize a test workspace (PoC contract + test), run
  `forge test`, capture result + traces + state diff
- verdict: verified = predicted state change observed (balance/storage/revert)

*Acceptance:* end-to-end on `examples/vulnerable-vault.sol` — a correct PoC
returns `verified: true`; a broken PoC returns `verified: false` with the
revert trace attached (the trace is the retry constraint, spec §5). Fork
killed mid-test → restarted and step re-enqueued, max once.

### 4. Loop orchestrator — `packages/core/loop.ts`

Step flow (spec §5): audit → parse findings → severity-ordered per finding:
`generate_poc → fork_verify` (≤2 retries, revert trace as next constraint) →
drop with `verification_failed` note after that (never reported) → report
verified only. Sequential per finding; findings processed in severity order.

*Acceptance:* fixture vault → report contains the verified reentrancy;
`examples/` safe contract → empty verified report (no shipped finding);
every step request + tool call visible in the event stream and the journal.

### 5. Journal v1 — `packages/journal/`

NDJSON session log at `~/.attis/sessions/<workdir>/<id>/`: prompts, step
requests, tool calls + args, PoC sources, fork responses (state diff), judge
verdicts, findings. **Flywheel-ready schema**: a verified-finding journal
entry must contain everything needed to emit an orgia-llm training row
(prompt code, thinking, finding, PoC, fork verdict) — design for direct
export.

*Acceptance:* `attis inspect <session>` (even a minimal printer) replays a
session from its journal; journal entry for a verified finding maps 1:1 to a
training-row shape.

## Done-when (v1 exit criteria) — ALL MET 2026-07-30

1. ✅ `attis audit examples/vulnerable-vault.sol --verify --output stream-json` →
   verified reentrancy finding in the final report, real anvil+forge run
   (verified: 1, dropped: 0)
2. ✅ Same command on a safe contract → zero findings shipped (safeVerdict)
3. ✅ `pnpm typecheck` clean; 19 tests green (parser, generate_poc, fork
   integration incl. real anvil+forge)
4. ✅ Journal for both sessions exists at `~/.attis/sessions/`, replayable via
   `attis inspect <events.jsonl>`, flywheel-shaped

## Explicitly NOT in v1

- Repo-scale decomposition (milestone 3), TUI (v2), MCP servers (v2),
  pod-mode serving lifecycle (v2), slither/judge tools (v2), RAG (v4)
- These get roadmap entries when their milestone starts — see the scope rule.
