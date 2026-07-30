# attis-cli Vision — Points to Milestones

> High-level reference: which capability lands in which milestone. Kept as a
> look-back data source — the operative plans live in `docs/roadmap.md`
> (per the scope rule, rewritten before each milestone starts).

| Point | Milestone | Status |
|---|---|---|
| Findings parser (strict) | v1 | **done** |
| generate_poc (exploit mode) | v1 | **done** |
| Fork layer (anvil+forge, retry-with-trace) | v1 | **done** |
| Deterministic orchestrator, journal v1 | v1 | **done** |
| Serving-manager (env/local/runpod drivers, auto-stop) | **v2** | per the golden rule by construction |
| slither / score / judge tools (spec §6 registry) | v2 | |
| Structurer fallback (c) for the unparseable tail | v2 | small |
| Tool-call findings smoke test (b) | v2 | decides the v3 output contract |
| TUI over the event stream, MCP servers | v2 | |
| Repo-scale decomposition (slither-ranked slices) | v3 | the big one |
| State-diff assertions (proof-grade labels) | v3 | when flywheel demands it |
| Code Mode evaluation | v3+ | |
| RAG over exploit corpus | v4 | |
| Flywheel loop closure (journal → training rows) | v5 | the moat, once journal shape stabilizes |
| Thinking budgets per phase | evidence-gated | measure token distributions first |

## Communication style (settled 2026-07-30)

- Envelope: OpenAI function-calling wire (codex/kimi-code style) for all
  harness actions (`fork_verify`, `generate_poc`, `slither_scan`, ...).
- Findings deliverable: (a) parse the trained prose contract (primary),
  (c) structurer fallback for the unparseable tail, (b) tool-call findings
  as a measured v2 smoke test that decides the v3 output contract.
- Code Mode (nanocodex): on the v3+ radar for exploit orchestration, not a
  foundation.
