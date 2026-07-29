# AGENTS.md — attis-cli

> Operating rules for the attis-cli repo (the harness that drives Orgia).
> Read `docs/spec.md` first — it is the source of truth for design decisions.

## Project context

attis-cli is a TUI-first, LLM-first agentic harness for EVM smart-contract
security auditing: the model hypothesizes, the chain verifies, only
fork-proven findings ship.

| Name | What | Visibility |
|---|---|---|
| **Orgia** | The model (trained LoRA adapters) | private (HF Hub) |
| **orgia-llm** | Data pipeline, datasets, eval bench, training | private repo |
| **attis-cli** | This repo — the harness | **public / open source** |

## The public-repo boundary (non-negotiable)

This repo is open source. The model work is not. The line:

- **Never commit secrets.** RPC keys, DeepSeek keys, HF tokens — env vars or
  `.env` (gitignored) only. Ship `.env.example` with placeholders.
- **No private infra references.** No pod IPs, SSH details, RunPod anything,
  no tokens embedded in URLs. Model endpoints and adapter paths are config,
  not constants.
- **No model IP in this repo.** Training data, dataset loaders, eval sets,
  and training scripts live in orgia-llm (private). The harness consumes the
  model over an OpenAI-compatible endpoint and must work with *any* endpoint —
  Orgia is the reference backend, not a hardcoded dependency.
- **Prompt/output contracts are fine to publish.** Output formats, judge
  prompts, execpolicy rules are orchestration, not moats.
- If a secret ever lands in history: rotate it immediately, then scrub.

## Git workflow

- **Commit and push after every update.** Small, frequent commits; never
  leave work unpushed at the end of a session.
- No force-push to `main`, no history rewrites on pushed commits.

## Design invariants (from docs/spec.md — do not regress)

1. **Verify, don't guess.** A finding ships only if a PoC proves it on a fork.
2. **Events-first.** No interaction exists in the TUI that is not available
   over the wire (stream-json out, JSON-RPC in).
3. **No silent behavior.** No telemetry, no phone-home, every tool call
   journaled.
4. **execpolicy gating.** Declarative rules decide what may execute;
   `cast send` with real keys is forbidden, period.

## Stack & conventions

- TypeScript; Pi framework (`earendilworks/pi`) as base — package-on-top,
  **confirmed by the spike** (spec §15); no fork needed.
- pnpm monorepo per spec §13: `packages/{serving,core}` now, `{tools,journal,rpc,tui}` next.
- Pin all `@earendil-works/*` deps to the same version (currently `0.82.1`).
- Commands:
  - `pnpm install` — install deps
  - `pnpm typecheck` — strict tsc over all packages
  - `pnpm attis audit <file.sol> -- --output stream-json` — headless audit
    (env: `ATTIS_BASE_URL`, `ATTIS_API_KEY`, `ATTIS_MODEL`, `ATTIS_ALLOW_FORK=1`
    to un-gate fork_verify)

## Status

Spike done (milestone 1): provider, thinking pass-through, tool gating all
verified live against DeepSeek; spec §15 holds the answers. Next: milestone
v1 loop (hypothesize → PoC → fork-verify → report) + the real fork layer.
