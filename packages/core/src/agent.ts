/**
 * @attis/core — agent construction for the auditor loop.
 *
 * Spike scope: Agent (pi-agent-core) + serving provider + fork_verify stub +
 * execpolicy-style beforeToolCall gate. The full phase orchestration
 * (audit → hypothesize → PoC → fork-verify → report) lands in milestone v1.
 */
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createServingModels, type ServingConfig } from "@attis/serving";
import { createForkVerifyTool } from "./tools/fork-verify.js";

export const AUDITOR_SYSTEM_PROMPT = `You are Orgia, an expert EVM smart-contract security auditor.

Analyze the provided code for vulnerabilities. Think through the code carefully: trace value flow, check access control, review external calls, and simulate adversarial interactions.

For each finding, report:
- **Severity:** Critical, High, Medium, or Low
- **Location:** function name and file
- **Description:** the vulnerability, its root cause, and how an attacker would exploit it
- **Proof of Concept:** concrete exploitation steps or code

If you identify a finding that can be proven on-chain, call the fork_verify tool with a PoC to verify it before reporting.

Format findings as:
### [Severity] Title
**Impact:** what an attacker gains and what the protocol loses
**Proof of Concept:** exploitation steps or code
**Remediation:** how to fix it

If the code is safe, state that clearly and explain the key safety properties you verified.`;

export interface AuditAgentOptions {
	serving?: Partial<ServingConfig>;
	onEvent?: (event: AgentEvent) => void;
}

export function createAuditAgent(opts: AuditAgentOptions = {}): Agent {
	const { models, model } = createServingModels();
	const agent = new Agent({
		initialState: {
			systemPrompt: AUDITOR_SYSTEM_PROMPT,
			model,
			thinkingLevel: "high",
			tools: [createForkVerifyTool()],
		},
		streamFn: models.streamSimple.bind(models),
		// Keyless local servers still need a placeholder (pi-ai throws otherwise).
		getApiKey: () => process.env.ATTIS_API_KEY ?? "EMPTY",
		// execpolicy-style gate: fork execution requires explicit opt-in.
		beforeToolCall: async (ctx) => {
			if (ctx.toolCall.name === "fork_verify" && process.env.ATTIS_ALLOW_FORK !== "1") {
				return {
					block: true,
					reason: "fork execution disabled (set ATTIS_ALLOW_FORK=1 to enable)",
				};
			}
			return undefined;
		},
		toolExecution: "sequential",
	});
	if (opts.onEvent) agent.subscribe(opts.onEvent);
	return agent;
}
