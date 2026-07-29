/**
 * fork_verify — run a PoC against a mainnet fork and report verification.
 *
 * STUB for the spike (q3): proves custom-tool registration, schema
 * validation, and the beforeToolCall approval flow work package-on-top.
 * The real implementation (anvil fork + forge test + state-diff check)
 * lands with the fork layer (spec §7).
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const Params = Type.Object({
	poc_code: Type.String({
		description: "Solidity PoC contract source (forge test contract).",
	}),
	hypothesis: Type.String({
		description: "One-line statement of the vulnerability being verified.",
	}),
});

export function createForkVerifyTool(): AgentTool<typeof Params> {
	return {
		name: "fork_verify",
		label: "fork verify",
		description:
			"Execute a proof-of-concept exploit for a hypothesized vulnerability on a mainnet fork (anvil) and report whether the predicted state change was observed. Use this to verify a finding before reporting it.",
		parameters: Params,
		execute: async (_toolCallId, params) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						verified: false,
						stub: true,
						note: "fork layer not wired yet — this is the spike stub returning a canned negative",
						hypothesis: params.hypothesis,
						poc_chars: params.poc_code.length,
					}),
				},
			],
			details: { stub: true, verified: false },
		}),
	};
}
