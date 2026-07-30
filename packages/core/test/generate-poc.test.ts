/**
 * Tests for generate_poc (exploit-mode tool). Endpoint is a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EXPLOIT_SYSTEM_PROMPT,
	buildPocUserPrompt,
	createGeneratePocTool,
} from "../src/tools/generate-poc.js";

const CFG = {
	baseUrl: "http://localhost:8000/v1",
	apiKey: "EMPTY",
	model: "orgia",
};

describe("generate_poc", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("calls the endpoint with the trained exploit-mode prompt", async () => {
		let seen: { url?: string; body?: { messages?: { role: string; content: string }[] } } = {};
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			seen.url = url;
			seen.body = JSON.parse(String(init.body));
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "## Exploit\nattack code here" } }],
				}),
				{ status: 200 },
			);
		});
		const tool = createGeneratePocTool(CFG);
		const result = await tool.execute("t1", {
			finding_title: "Reentrancy in withdraw()",
			finding_impact: "Funds drained",
			contract_code: "contract Vault {}",
		});
		expect(seen.url).toBe("http://localhost:8000/v1/chat/completions");
		const msgs = seen.body!.messages!;
		expect(msgs[0].content).toBe(EXPLOIT_SYSTEM_PROMPT);
		expect(msgs[1].content).toContain("Reentrancy in withdraw()");
		expect(msgs[1].content).toContain("contract Vault {}");
		expect(result.content[0].text).toContain("attack code here");
	});

	it("user prompt carries finding + code in the trained shape", () => {
		const p = buildPocUserPrompt("Bug X", "Impact Y", "contract Z {}");
		expect(p).toContain("This contract has a vulnerability");
		expect(p).toContain("Vulnerability: Bug X");
		expect(p).toContain("Impact: Impact Y");
		expect(p).toContain("```solidity\ncontract Z {}\n```");
	});

	it("exploit system prompt matches the orgia-llm trained prompt", () => {
		// Sync guard with data_pipeline/format/system_prompt.py (exploit).
		expect(EXPLOIT_SYSTEM_PROMPT).toContain("Write a concrete exploit");
		expect(EXPLOIT_SYSTEM_PROMPT).toContain("expected result of a successful exploit");
	});

	it("throws on endpoint error", async () => {
		vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
		const tool = createGeneratePocTool(CFG);
		await expect(
			tool.execute("t1", { finding_title: "x", contract_code: "c" }),
		).rejects.toThrow("endpoint error");
	});
});
