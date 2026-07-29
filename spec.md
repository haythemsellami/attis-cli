# attis-cli — Spec

> **Attis drives Orgia.** A TUI-first, LLM-first agentic harness for EVM
> smart-contract security auditing: the model hypothesizes, the chain verifies,
> only fork-proven findings ship.

**Status:** v0 draft — pre-spike. Every decision below is an *agreed* decision
unless marked **[OPEN]**.

---

## 1. Naming & family

| Name | What it is |
|---|---|
| **Orgia** | The LLM itself (trained weights/adapter). Swallows contracts, brings forth findings. |
| **orgia-llm** | The data/model repo: data pipeline, datasets, eval bench, training scripts (formerly evm69). |
| **attis-cli** | This project: the harness that drives Orgia at runtime (Pi-based agent core + TUI). |
| **HF repos** | `haythem96/evm69-*` — legacy names, kept (HF repos can't be renamed; migrate later, deliberately). |

## 2. Product principles

1. **Verify, don't guess.** A finding only ships if a PoC proves it on a
   mainnet fork. The moat is the verification loop, not the weights.
2. **Events-first.** Every interaction available to a human in the TUI is
   available to an LLM over the wire. The TUI is *one consumer* of the event
   stream, never the only one.
3. **LLM as first-class citizen.** The harness is scriptable, debuggable, and
   drivable by other agents: headless stream-json out, JSON-RPC/SDK control in.
4. **Fork the design, not the repos.** Base = Pi (framework). Patterns stolen
   from kimi-code (loop + tools + permissions), codex (orchestration + policy),
   nanocodex (Code Mode) — see §10.
5. **No silent behavior.** No telemetry, no phone-home, no hidden network calls.
   Every tool execution is visible in the journal.

## 3. Base framework

**Pi** (`earendilworks/pi` — Mario Zechner's TypeScript agent monorepo, MIT).

- `packages/agent` — agent runtime (loop, tools, sessions, compaction)
- `packages/ai` — multi-provider LLM API (add vLLM as an OpenAI-compatible provider)
- `packages/tui` — differential-rendering terminal UI (our primary interface)
- `packages/coding-agent` — reference CLI

Consumption mode: **package-on-top** (build attis-cli as a package against Pi's
SDK, registering our tools) rather than a fork. Fork only if the spike proves
extension points insufficient. **[OPEN]** Pi is single-author with restricted
contribution — self-sufficient maintenance assumed.

## 4. Architecture

```
┌─────────────────────────── attis-cli (this repo) ───────────────────────────┐
│  TUI (Pi tui)         headless: stream-json out      JSON-RPC/SDK in        │
│       │                        ▲                           │                │
│  ┌────┴────────────────────────┴───────────────────────────┴────┐           │
│  │              Agent core (Pi agent runtime)                    │           │
│  │   audit → hypothesize → PoC → fork-verify → iterate → report │           │
│  └────┬──────────────┬───────────────┬──────────────┬───────────┘           │
│       │              │               │              │                       │
│  ┌────┴───┐   ┌──────┴─────┐   ┌─────┴──────┐  ┌────┴─────────┐            │
│  │ vLLM   │   │ Tool layer │   │ Fork layer │  │ Journal      │            │
│  │ server │   │ (see §6)   │   │ (see §7)   │  │ (see §9)     │            │
│  └────────┘   └────────────┘   └────────────┘  └──────────────┘            │
└─────────────────────────────────────────────────────────────────────────────┘
        │                                │
  Orgia (LoRA on vLLM)           anvil fork + forge (RPC: Alchemy)
```

## 5. The agent loop

Modeled on kimi-code's drain-loop + typed request queue (everything is a plugin):

- Core loop pops typed **step requests**; each phase transition is an
  orchestrator enqueueing a request with admission + merge semantics.
- **Continuation is a plugin**: on tool calls → continue; on `stopTurn` → end.
- Phase flow: `audit(code) → hypothesize(findings) → for each: generate PoC →
  fork-execute → check state diff → keep verified → report`.
- **Failure handling as an ordered handler chain** (first-match-wins):
  provider 429/5xx → backoff + re-enqueue; context overflow → compact +
  re-enqueue; **`ForkDied` / RPC timeout → restart fork + re-enqueue verify step**
  (our custom handler).
- PoC reverted on fork → enqueue a mergeable retry step carrying the revert
  trace as the next constraint (max 2 retries per hypothesis, then drop with a
  `verification_failed` note — never reported as a finding).

## 6. Tool system

Wire format: **OpenAI function calling** (JSON-schema params, `tool_calls`) —
native to vLLM/Qwen3.5/DeepSeek.

Per-tool design (kimi-style): each tool =
`schema + resolveExecution → { accesses, approvalRule, execute }`.
The model sees the schema; the harness sees the policy.

Registry v1:

| Tool | Type | Accesses | Approval | Notes |
|---|---|---|---|---|
| `slither_scan` | read | contract files | auto (read-only) | static pass, JSON findings |
| `fork_verify` | exec | anvil, forge | policy-gated (execpolicy) | run PoC on fork, return state-diff + traces |
| `audit_repo` | read | repo files | auto | file discovery for repo-scale audits |
| `score_finding` | read | — | auto | custom scorer (port/wrap from Python) |
| `judge_semantic` | net | DeepSeek API | ask (network) | DeepSeek judge + TP-alt; `judge_control` trust check |
| `generate_poc` | llm | model | auto | exploit-format generation (trained format) |
| `report` | write | workspace | auto | emits final report + ends turn (`stopTurn`) |

Gating (codex execpolicy-style, declarative + self-testing):

```starlark
prefix_rule(pattern=["forge", "test"], decision="allow")
prefix_rule(pattern=["anvil", "--fork-url"], decision="allow")
prefix_rule(pattern=["cast", "send", "--private-key"], decision="forbidden")
prefix_rule(pattern=["*", "curl", "*"], decision="prompt")
```

MCP: `fork_verify`, `slither_scan`, `judge_semantic` are also exposed as **MCP
servers** so codex/kimi/other clients can call them.

## 7. Model serving & fork layer

**Serving** (existing vLLM harness, reused as-is):

```
vllm serve unsloth/Qwen3.5-9B --enable-lora \
  --lora-modules orgia=/workspace/adapters/qwen35-9b-v61 \
  --max-lora-rank 64 --language-model-only \
  --max-model-len 131072 --kv-cache-dtype fp8 --reasoning-parser qwen3
```

- Current line: Qwen3.5-9B adapters (`qwen35-9b-v61` probe), **thinking ON**.
  The 7B champion `phase3f-7b-v6` (LoRA on `Qwen/Qwen2.5-Coder-7B-Instruct`)
  is the legacy reference for eval deltas.
- Adapters are swappable LoRA modules (`--lora-modules name=path`).
- Generation budget default: 32k tokens (probe showed thinking traces need it);
  per-tool overrides allowed.
- Provider adapter: OpenAI-compatible chat completions against the vLLM server.

**Fork layer**:

- `anvil --fork-url $RPC_URL` (Alchemy, API key in env) — fork at the
  vulnerable block (or latest for source-only audits).
- `forge test` executes the generated PoC in the fork; verification =
  predicted state change observed (balance, storage slot, revert-or-not).
- A PoC that reverts → retry with trace (≤2). Still failing →
  `verification_failed` (not a finding).

## 8. Judge & scorer (ported from orgia-llm)

- **Scorer**: parse model output → findings; title-overlap match vs expected;
  TP/FP/FN/TN; per-severity + per-source metrics. Port from Python (thin) or
  wrap as a local microservice on day one (zero port).
- **Judge**: DeepSeek (`deepseek-v4-pro`, OpenAI-compatible) semantic judge.
  Verdicts: `same` (paraphrase → TP), `valid` (real different bug → TP-alt),
  `invalid` (FP). `judge_control` mismatch-control runs on judge changes
  (target: false-same rate ≤ 10%).

## 9. Journal (evidence trail)

Every run appends a **wire journal** (JSONL): prompt, step requests, tool
calls + args, PoC sources, fork responses (state diff), judge verdicts,
findings. Stored under `~/.attis/sessions/<workdir>/<id>/`.

- Resume = replay. Fork a session at any step index
  ("re-run the exploit from step 12 with the patched contract").
- `attis inspect <session>` renders it; the same journal feeds the LLM-first
  debug surface.

## 10. LLM-first interface (alongside the TUI)

- **Headless**: `attis audit <target> --output stream-json` — NDJSON of the
  same events the TUI renders.
- **Control**: JSON-RPC over stdio (codex app-server / kimi ACP shape):
  `prompt`, `steer`, `cancel`, `fork`, `session.list/get`.
- **SDK**: thin TS client over the JSON-RPC surface (v2, not v1).
- Principle (README-eternal): *no interaction exists in the TUI that is not
  available over the wire.*

## 11. Security & approvals

- execpolicy file as in §6, loaded at startup, self-tested.
- Permission chain (~3 rules to start):
  auto-approve read-only tools (slither, audit_repo, score) →
  ask on network/real-RPC (judge, non-fork cast) →
  deny writes outside the workspace.
- No sandbox is claimed beyond: anvil isolates exploit execution; the QuickJS
  cell (Code Mode) has no fs/net.
- Secrets: RPC/DeepSeek keys via env / `.env` (gitignored), never logged.

## 12. Eval & benchmark

- **Project-level**: ScaBench code benchmark (22 full repos, zero hints,
  no truncation) — the harness's own test-suite for repo-scale audits.
- **Per-contract**: the 843-example frozen set + DeepSeek judge for iteration.
- Metric: verified-precision (findings that survive fork verification) vs raw.

## 13. Repo layout (target)

```
attis-cli/
├── packages/
│   ├── core/          # agent loop on Pi runtime (step-request orchestrators)
│   ├── tools/         # slither, fork_verify, judge, score, generate_poc, report
│   ├── serving/       # vLLM provider adapter
│   ├── journal/       # wire journal + replay + inspect
│   ├── rpc/           # JSON-RPC server (LLM-first control)
│   └── tui/           # attis TUI on Pi tui
├── bin/attis          # CLI entry (TUI default; --output stream-json headless)
├── policy/
│   └── execpolicy.starlark
├── mcp/               # MCP servers (fork_verify, slither, judge)
└── spec.md            # this file
```

## 14. Milestones

1. **Spike** (1 day): Pi + vLLM provider + `fork_verify` stub + headless
   stream-json audit on one ScaBench project. Answers the three open questions
   in §15.
2. **v1 loop**: full hypothesize→PoC→fork-verify→report on per-contract input.
3. **Repo-scale**: scope discovery + multi-finding reports on the 22-project set.
4. **RAG**: retrieval over the exploit corpus (orgia-llm loaders) into prompts.
5. **Self-play data**: verified PoCs from the loop become new training data for Orgia.

## 15. Open questions

- **[ANSWERED — spike, 2026-07-29]** Does Pi's provider layer accept a local vLLM `base_url` cleanly? **Yes.** `createProvider({ baseUrl, api: openAICompletionsApi(), auth, models })` + `models.setProvider()` — no closed registry. Gotchas handled in `packages/serving`: keyless servers need a dummy API key; `Model.compat` must pin `maxTokensField: "max_tokens"`, `supportsStore: false`, `supportsReasoningEffort: false` (auto-detect guesses wrong for unknown base URLs).
- **[ANSWERED — spike]** Qwen3.5 thinking traces: pass-through of `reasoning_content` — **works natively.** pi-ai's openai-completions stream parser maps `reasoning_content`/`reasoning`/`reasoning_text` into `ThinkingContent` + `thinking_start/delta/end` events (verified: 370 thinking deltas in one audit). No adapter needed.
- **[ANSWERED — spike]** Pi extension points: **package-on-top confirmed.** Custom `AgentTool` registration is array-based (no registry); `beforeToolCall` approval hook blocks with a reason that reaches the model (verified: fork_verify call gated, model adapted). No fork required. Watch: pass `streamFn` explicitly; approval hooks must be re-entrancy-safe under parallel tool execution (we use `sequential`); pin all `@earendil-works/*` deps to the same version.
- **[OPEN]** RPC provider choice (Alchemy default) and its rate limits under fork-verify load.
- **[OPEN]** TUI framework surface vs headless parity — keep both in lockstep from day one.

## 16. Design lineage (what we stole from whom)

- **kimi-code**: drain-loop + StepRequest queue, continuation-as-plugin,
  veto-event tool adjudication, 12-policy permission chain, wire journal,
  per-subagent model binding.
- **codex**: ToolOrchestrator (approval→sandbox→attempt→escalate), execpolicy
  Starlark rules (self-testing), Guardian-style judge circuit breaker
  (3 consecutive / 10-of-50 denials → kill).
- **nanocodex**: Code Mode (sandboxed exec cell composing tools),
  immutable segmented history + O(1) session forks, tool-output budgeting.
- **Pi**: the framework itself (agent runtime, TUI, providers).
