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

## Communication style (settled 2026-07-30, updated 2026-08 after smoke)

- **Envelope**: OpenAI function-calling wire (codex/kimi-code style) for all
  harness actions (`fork_verify`, `generate_poc`, `slither_scan`, ...). It
  is the de facto standard every provider speaks — provider-agnostic by design.
- **Schema content is OURS, not codex's**: the catalog is domain tools
  (`fetch_file`, `fork_verify`, `slither_scan`, `report`) — the moat lives
  in the catalog, not the envelope. `shell`/`apply_patch` belong to
  generic-coding harnesses, not to an auditor.
- **Layers stolen**: codex execpolicy (Starlark, self-testing), Claude-style
  tool-constraint descriptions in the system prompt (when/how/not-to-call
  per tool), kimi per-tool metadata (`schema + resolveExecution →
  {accesses, approvalRule, execute}`).
- **Code mode = fork execution** (not a Python REPL): the model writes
  forge tests, the fork sandbox runs them, the chain reports ground truth.
- **Model-facing surface (smoke verdict 2026-08)**: current LoRAs emit 0/30
  native tool calls — narrow SFT overwrote the base tool-calling prior.
  Model requests use deterministic text markers (`<<fetch: path>>`) until
  orgia v8 retrains tool discipline with a tool-call data mix (OpenAI wire
  shape, 5-10% of dataset). Findings deliverable stays: (a) parse the
  trained prose contract (primary), (c) structurer fallback for the tail.
