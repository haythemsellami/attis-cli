<div align="center">
  <img src="docs/assets/attis-banner-reclining.png" alt="attis — the harness that drives Orgia" width="100%">
  <h1>attis-cli</h1>
  <p><strong>An open-source agentic harness for EVM smart-contract security auditing.<br>
  The model hypothesizes. The chain verifies. Only fork-proven findings ship.</strong></p>
  <p>
    <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ES2022-3178c6">
    <img alt="tests: 19 passing" src="https://img.shields.io/badge/tests-19%20passing-brightgreen">
  </p>
</div>

---

Most LLM-auditor demos stop at generation: a model reads code and writes plausible-sounding findings, a large share of which are wrong. attis closes the loop that makes findings trustworthy: every hypothesized vulnerability must be **proven by an exploit executing on a real chain fork** — or it is dropped from the report, unreported.

attis drives **Orgia**, a fine-tuned Solidity auditor, but works with any OpenAI-compatible endpoint (local vLLM, DeepSeek, OpenAI...).

## Why attis

- **Verify, don't guess.** `audit → parse → per-finding PoC → fork-verify (anvil + forge) → report`. Findings that fail on-chain are marked `verification_failed` and never shipped.
- **Events-first.** The TUI is one consumer of the event stream, never the only one. Everything is also available over NDJSON (`--output stream-json`) — the harness is scriptable and drivable by other agents from day one.
- **Model-aware, not model-agnostic.** attis does not treat the model as a black box: it parses Orgia's output into typed findings deterministically and drives its exploit-generation capability natively — no generic prompt-and-pray.
- **Permissioned execution.** Declarative execpolicy rules (Starlark) decide what may execute. Private-key transaction signing (e.g. `cast send --private-key`) is categorically forbidden.
- **The flywheel.** Every session writes a wire journal (prompts, tool calls, PoC sources, fork verdicts) — verified findings become provable training data for the next model iteration.

## Quickstart

Prerequisites: Node 24+, pnpm, foundry (`forge` + `anvil` on PATH), and an OpenAI-compatible model endpoint.

```bash
pnpm install

# point at your endpoint (local vLLM default, or DeepSeek)
export ATTIS_BASE_URL="http://localhost:8000/v1"
export ATTIS_API_KEY="EMPTY"          # any placeholder for keyless servers
export ATTIS_MODEL="orgia"

# audit a contract — full verification loop
pnpm attis audit examples/vulnerable-vault.sol -- --verify --output stream-json
```

The final report contains only findings whose PoC passed on an anvil fork. A plain (unverified) audit is `attis audit <file.sol>`.

```bash
# replay any session
pnpm attis inspect ~/.attis/sessions/<workdir>/<session>/events.jsonl

# tests + typecheck
pnpm test && pnpm typecheck
```

## How the loop works

```
 contract.sol
     │
     ▼
  audit (model, thinking on) ──► typed findings
     │                                │
     │                        per finding, severity order
     ▼                                ▼
 generate_poc (exploit mode) ──► fork_verify (anvil + forge test)
     │                                │
     │                        pass → verified finding
     │                        fail → retry ≤2 with revert trace
     │                        still failing → dropped, never reported
     ▼
 report (verified findings only)  +  wire journal (NDJSON)
```

## Currently implemented (v1)

- [x] Full verify loop: audit → parse → per-finding PoC → fork-verify → report (acceptance-verified on the fixture vault and the safe case)
- [x] Pi-based agent runtime (package-on-top) with native thinking-trace streaming
- [x] Serving factory for OpenAI-compatible endpoints (vLLM / DeepSeek), env-configured
- [x] execpolicy gate for fork execution
- [x] `attis audit`, `attis inspect`, NDJSON stream-json events, session journal

## License

GNU AGPL v3 — see [LICENSE](LICENSE). Use it, fork it, audit with it; if you
run a modified attis as a network service for others, you must share that
modified source with its users (AGPL §13).
