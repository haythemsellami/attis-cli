/**
 * @attis/core — agent construction for the auditor loop.
 *
 * Spike scope: Agent (pi-agent-core) + serving provider + fork_verify stub +
 * execpolicy-style beforeToolCall gate. The full phase orchestration
 * (audit → hypothesize → PoC → fork-verify → report) lands in milestone v1.
 */
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createServingModels, servingConfigFromEnv, type ServingConfig } from "@attis/serving";
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
	/** Endpoint overrides, merged over the ATTIS_* env config (teacher rollouts). */
	serving?: Partial<ServingConfig>;
	/** Tool set; defaults to the v1 fork_verify stub. Rollouts pass execute_code. */
	tools?: AgentTool<any>[];
	/** System prompt override (repo rollouts use the kernel-mode prompt). */
	systemPrompt?: string;
	/** Sampling temperature (default 0 — audit work wants determinism, not variety). */
	temperature?: number;
	/** Per-request timeout in ms (default ATTIS_TIMEOUT_MS ?? 600000 — thinking
	 *  requests on large transcripts take minutes; short defaults caused the
	 *  batch-2 timeout wave). */
	timeoutMs?: number;
	onEvent?: (event: AgentEvent) => void;
}

function mergeServingConfig(base: ServingConfig, over: Partial<ServingConfig> = {}): ServingConfig {
	return {
		baseUrl: over.baseUrl ?? base.baseUrl,
		apiKeyEnv: over.apiKeyEnv ?? base.apiKeyEnv,
		modelId: over.modelId ?? base.modelId,
		contextWindow: over.contextWindow ?? base.contextWindow,
		maxTokens: over.maxTokens ?? base.maxTokens,
		providerId: over.providerId ?? base.providerId,
	};
}

/** First set value among the config's key env vars ("EMPTY" for keyless local servers). */
function apiKeyFromEnv(apiKeyEnv: readonly string[]): string {
	for (const name of apiKeyEnv) {
		const value = process.env[name];
		if (value) return value;
	}
	return "EMPTY";
}

export function createAuditAgent(opts: AuditAgentOptions = {}): Agent {
	const cfg = mergeServingConfig(servingConfigFromEnv(), opts.serving);
	const { models, model } = createServingModels(cfg);
	const agent = new Agent({
		initialState: {
			systemPrompt: opts.systemPrompt ?? AUDITOR_SYSTEM_PROMPT,
			model,
			thinkingLevel: "high",
			tools: opts.tools ?? [createForkVerifyTool()],
		},
		streamFn: (model, context, options) =>
			models.streamSimple(model, context, {
				...options,
				temperature: opts.temperature ?? 0,
				timeoutMs: opts.timeoutMs ?? Number(process.env.ATTIS_TIMEOUT_MS ?? 600_000),
			}),
		// Keyless local servers still need a placeholder (pi-ai throws otherwise).
		getApiKey: () => apiKeyFromEnv(cfg.apiKeyEnv),
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
