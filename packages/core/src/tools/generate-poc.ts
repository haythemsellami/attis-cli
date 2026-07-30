/**
 * generate_poc — exploit-mode PoC generation (spec §6, llm type, auto).
 *
 * Invokes the model with its TRAINED exploit-mode system prompt (ported
 * verbatim from orgia-llm's system_prompt.py — keep in sync; there is a
 * test asserting the exact text) for a given finding + contract code.
 * Not a generic "write an exploit pls" prompt — the model's own format.
 *
 * The tool performs a direct chat-completions call to the serving endpoint
 * (a side-channel model call, not an agent turn), so the orchestrator can
 * request PoCs per finding without steering the main agent loop off-course.
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// Ported verbatim from orgia-llm data_pipeline/format/system_prompt.py
// (get_system_prompt("exploit")). Sync-guarded by test.
export const EXPLOIT_SYSTEM_PROMPT =
	"You are an expert Solidity/EVM security researcher. You are given a contract " +
	"with a known vulnerability. Write a concrete exploit (attack contract, call " +
	"sequence, or Foundry test) that demonstrates it, explain the attack path step " +
	"by step, and state the expected result of a successful exploit.";

const Params = Type.Object({
	finding_title: Type.String({ description: "Title of the finding to prove." }),
	finding_impact: Type.Optional(
		Type.String({ description: "Impact description of the finding." }),
	),
	contract_code: Type.String({
		description: "The vulnerable contract source the PoC targets.",
	}),
	retry_hint: Type.Optional(
		Type.String({
			description:
				"Revert trace or failure note from a previous PoC attempt — fix the PoC to address it.",
		}),
	),
});

export interface GeneratePocConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens?: number;
}

export function buildPocUserPrompt(
	findingTitle: string,
	findingImpact: string | undefined,
	contractCode: string,
	retryHint?: string,
): string {
	const impact = findingImpact ? `\nImpact: ${findingImpact}` : "";
	const retry = retryHint
		? `\n\nA previous PoC attempt failed with:\n${retryHint}\nFix the PoC to address this.`
		: "";
	return `This contract has a vulnerability. Write the exploit that proves it:\n\n` +
		`Vulnerability: ${findingTitle}${impact}\n\n` +
		`\`\`\`solidity\n${contractCode}\n\`\`\`${retry}`;
}

const FENCE_RE = /```(?:solidity|sol)?\s*\n([\s\S]*?)```/g;

/**
 * Extract compilable Solidity from a PoC generation: the model wraps code in
 * prose ("Below is a Foundry test..."), and prose in a .sol file fails the
 * compiler. Prefer the LARGEST fenced block; fall back to the whole output
 * only when it already looks like bare Solidity (starts with pragma/contract).
 */
export function extractPocCode(output: string): string {
	const blocks = [...output.matchAll(FENCE_RE)]
		.map((m) => m[1].trim())
		.filter(Boolean);
	if (blocks.length > 0) {
		return blocks.reduce((a, b) => (b.length >= a.length ? b : a));
	}
	const trimmed = output.trim();
	if (/^(pragma|contract|library|interface|import|\/\/|\/\*)/.test(trimmed)) {
		return trimmed;
	}
	return trimmed;
}

export function createGeneratePocTool(cfg: GeneratePocConfig): AgentTool<typeof Params> {
	return {
		name: "generate_poc",
		label: "generate PoC",
		description:
			"Generate a concrete proof-of-concept exploit (attack contract, call sequence, or Foundry test) for a hypothesized vulnerability, using the model's trained exploit mode. Returns the PoC source and expected result.",
		parameters: Params,
		execute: async (_toolCallId, params) => {
			const body = {
				model: cfg.model,
				messages: [
					{ role: "system", content: EXPLOIT_SYSTEM_PROMPT },
					{
						role: "user",
						content: buildPocUserPrompt(
							params.finding_title,
							params.finding_impact,
							params.contract_code,
							params.retry_hint,
						),
					},
				],
				max_tokens: cfg.maxTokens ?? 4096,
				temperature: 0,
			};
			const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${cfg.apiKey}`,
				},
				body: JSON.stringify(body),
			});
			if (!resp.ok) {
				throw new Error(`generate_poc endpoint error: ${resp.status} ${await resp.text()}`);
			}
			const data = (await resp.json()) as {
				choices: { message: { content?: string } }[];
			};
			const poc = data.choices[0]?.message?.content ?? "";
			const code = extractPocCode(poc);
			return {
				content: [{ type: "text", text: poc }],
				details: { chars: poc.length, code },
			};
		},
	};
}
