/**
 * execute_code — the ONE model-facing tool (spec §6, roadmap v2 item 2).
 *
 * A persistent Python kernel per audit session (prime-agent RLM shape)
 * booted with the audit helper library (repo.*, fork.*, slither.*,
 * snapshot/revert) over the fork substrate. Every execution is journaled
 * (code + result — the flywheel's raw material) and gated by the
 * execpolicy's best-effort static scan before it reaches the kernel.
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExecResult, Kernel, Policy } from "@attis/kernel";
import type { Journal } from "@attis/journal";

const Params = Type.Object({
	code: Type.String({
		description:
			"Python code to execute in the persistent audit kernel. Variables and imports survive across calls. Preloaded helpers: repo.tree()/repo.read(path), fork.create(rpc_url?, block?)/fork.verify(poc_source, setup?)/fork.snapshot()/fork.revert(id), slither.scan(path?). fork.verify auto-detects the repo's foundry project (root or nested ≤2 levels) and runs the PoC inside it with deps auto-provided (forge-std/OpenZeppelin/solmate/solady) — override with setup={\"foundry_root\": \"<path>\"}; on repos without foundry.toml it stages sources + remappings into a template workspace.",
	}),
	timeout_ms: Type.Optional(
		Type.Number({ description: "Per-call timeout in milliseconds (default 120000)." }),
	),
});

/** resolveExecution metadata (spec §6): what the tool touches + how it's gated. */
export interface ExecutionMeta {
	accesses: readonly ["kernel", "scratch", "anvil-pool"];
	approvalRule: "policy";
}

/** The tool carries its execution metadata alongside the Pi AgentTool shape. */
export type ExecuteCodeTool = AgentTool<typeof Params> & {
	resolveExecution: () => ExecutionMeta;
};

export interface ExecuteCodeDeps {
	kernel: Kernel;
	policy: Policy;
	journal: Journal;
}

/** Cap fields the model sees; the full values stay in details + journal. */
const MODEL_FIELD_CAP = 12_000;

function cap(s: string): string {
	return s.length > MODEL_FIELD_CAP ? `${s.slice(0, MODEL_FIELD_CAP)}\n... <truncated>` : s;
}

function modelPayload(r: ExecResult): Record<string, unknown> {
	return {
		ok: r.ok,
		stdout: cap(r.stdout),
		stderr: cap(r.stderr),
		result: r.result,
		error: r.error,
		...(r.restarted
			? { restarted: true, note: "kernel restarted — previous namespace is gone; re-declare variables" }
			: {}),
	};
}

export function createExecuteCodeTool(deps: ExecuteCodeDeps): ExecuteCodeTool {
	return {
		name: "execute_code",
		label: "execute code",
		description:
			"Execute Python in the persistent audit kernel to inspect the mounted repo and verify hypotheses on-chain. Helpers: repo.tree() (file listing + import graph), repo.read(path), fork.create(rpc_url?, block?) (spawn an anvil fork), fork.verify(poc_source, setup?) (run a forge PoC, returns a verdict), fork.snapshot()/fork.revert(id), slither.scan(path?). DO: verify every finding with a fork PoC before reporting it. DO NOT: access the network outside the RPC proxy, use real private keys, or write outside the scratch dir — the execpolicy blocks these.",
		parameters: Params,
		resolveExecution: () => ({
			accesses: ["kernel", "scratch", "anvil-pool"],
			approvalRule: "policy",
		}),
		execute: async (_toolCallId, params) => {
			// 1. execpolicy static scan (best-effort tripwire — see policy.ts).
			const scan = deps.policy.scanCode(params.code);
			if (scan.decision === "forbidden") {
				const hits = scan.hits.map((h) => `${h.literal} (line ${h.line})`);
				await deps.journal.write("kernel_exec", {
					blocked: true,
					policy_hits: hits,
					code: params.code,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								ok: false,
								blocked: true,
								reason: `execpolicy forbids: ${hits.join(", ")}. Network access and raw keys are not available in the kernel — use the fork helpers instead.`,
							}),
						},
					],
					details: { blocked: true, policyHits: scan.hits },
				};
			}

			// 2. Execute; journal everything (verified traces are training data).
			const result = await deps.kernel.exec(params.code, {
				...(params.timeout_ms !== undefined ? { timeoutMs: params.timeout_ms } : {}),
			});
			if (result.restarted) {
				await deps.journal.write("kernel_restart", { reason: "sidecar died; fresh namespace" });
			}
			await deps.journal.write("kernel_exec", {
				code: params.code,
				ok: result.ok,
				result: result.result,
				error: result.error,
				stdout: cap(result.stdout),
				stderr: cap(result.stderr),
				duration_ms: result.durationMs,
				restarted: result.restarted,
			});

			return {
				content: [{ type: "text", text: JSON.stringify(modelPayload(result)) }],
				details: result,
			};
		},
	};
}
