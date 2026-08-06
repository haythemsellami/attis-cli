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
| Tool-call smoke | v2 | **done** — verdict: 0/30 native from v7.x LoRA; native wire kept, fix is v8 trace mix + teacher bootstrap |
| Serving-manager (env/local/runpod drivers, auto-stop) | **v2** | per the golden rule by construction |
| `execute_code` kernel + audit helper library | v2 | persistent IPython, local driver first |
| judge / score tools (harness-side) | v2 | |
| Structurer fallback (c) for the unparseable tail | v2 | small |
| TUI over the event stream, MCP servers | v2 | |
| Repo-scale decomposition (slither-ranked slices) | v3 | the big one; prime-agent's `rlm(...)` recursion pattern is the reference |
| State-diff assertions (proof-grade labels) | v3 | when flywheel demands it |
| Sandbox hardening (`docker` executor driver) | v3+ | triggers: fleet scale, untrusted code, hermetic eval |
| RAG over exploit corpus | v4 | |
| Flywheel loop closure (journal → training rows) | v5 | the moat, once journal shape stabilizes |
| Thinking budgets per phase | evidence-gated | measure token distributions first |

## Communication style (settled 2026-07-30; revised 2026-08 after smoke + code-mode design review)

- **Envelope**: OpenAI function calling as the **single runtime wire** —
  native `tool_calls` end to end, no text-marker fallback. vLLM parses
  Qwen's native format out of the box; TRL/verifiers/prime-rl eat it
  directly; prime-agent and any third-party harness can drive Orgia as-is.
- **Forgetting fix (0/30 smoke)**: orgia v8 trains a code-mode trace mix
  (10–15% of the dataset, native wire) — the lab-standard hygiene that
  keeps the base model's tool-calling prior alive. v8 pre-flight:
  chat-template round-trip test + post-train smoke (target >95%
  schema-valid native calls).
- **Bridge for bootstrap traces**: teacher-driven rollouts (base
  Qwen3.5-9B or deepseek-v4-pro) produce v8's first code-mode traces — no
  marker crutch; traces are born in the target format.
- **Code mode = persistent IPython kernel + fork substrate** (prime-agent's
  RLM shape, grounded by our fork layer): ONE model-facing tool,
  `execute_code`; foundry + anvil pool live inside the execution
  environment, so the chain reports ground truth through code output.
- **The catalog moved into the kernel**: the audit helper library
  (`fork.*`, `slither.*`, `repo.*`, `snapshot/revert`) is the typed-tool
  moat reborn as a Python API — minimal now, extended by rollout evidence.
  New domains (Rust/Go later) = toolchain in the execution image + helper
  module + per-domain fine-tune, zero harness surgery.
- **Layers stolen**: codex execpolicy (Starlark, self-testing) at the
  executor chokepoint, Claude-style tool-constraint descriptions in the
  system prompt, kimi per-tool metadata (`schema + resolveExecution →
  {accesses, approvalRule, execute}`), prime-agent kernel bootstrap.
- **Executor**: behind a driver interface — `local` now (non-root,
  per-session tmp repo copy, hard timeouts, network locked to the RPC
  proxy), `docker` deferred (triggers: fleet scale, untrusted code,
  hermetic eval).
- Findings deliverable stays: (a) parse the trained prose contract
  (primary), (c) structurer fallback for the tail.
