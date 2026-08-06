/**
 * Flywheel contract end-to-end (roadmap v2 items 3+5 acceptance):
 * a session run through the audit loop journals FULL text (prompt, output,
 * PoC source — not just char counts), and the journal exports a
 * schema-valid orgia-llm training row with the right label.
 *
 * Test 1 (safe session) runs everywhere. Test 2 (verified session) needs
 * foundry on PATH — guarded like the kernel/fork integration tests.
 */
import { execSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import { Journal, exportSession, validateRow } from "@attis/journal";
import { startAnvil, type AnvilHandle } from "@attis/fork";
import { runAuditLoop } from "../src/loop.js";

const SYSTEM_PROMPT = "TEST SYSTEM PROMPT — flywheel";

const SAFE_REPLY =
	"I reviewed the contract. No vulnerabilities found — the code is safe.";

const FINDING_REPLY = `## Findings

### [High] Reentrancy in withdraw()

**Impact:** An attacker can drain the contract's entire ETH balance by re-entering withdraw() before the balance is zeroed.

**Remediation:** Apply checks-effects-interactions: zero the balance before the external call.`;

const VAULT_CODE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function withdraw() external {
        (bool ok, ) = msg.sender.call{value: balances[msg.sender]}("");
        require(ok);
        balances[msg.sender] = 0;
    }
}`;

const hasFoundry = (() => {
	try {
		execSync("which anvil && which forge", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

/** Minimal Agent stand-in: runAuditLoop only needs prompt/waitForIdle/state. */
function fakeAgent(reply: string): Agent {
	const state = { messages: [] as unknown[] };
	return {
		state,
		prompt: async (text: string) => {
			state.messages.push({ role: "user", content: [{ type: "text", text }] });
			state.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
		},
		waitForIdle: async () => {},
		subscribe: () => {},
	} as unknown as Agent;
}

function stubPocTool(code: string): AgentTool<any> {
	return {
		execute: async () => ({ content: [{ type: "text", text: code }] }),
	} as unknown as AgentTool<any>;
}

const tmpDirs: string[] = [];
let savedHome: string | undefined;

async function tmpHome(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-flywheel-"));
	tmpDirs.push(dir);
	savedHome = process.env.HOME;
	process.env.HOME = dir;
	return dir;
}

afterEach(async () => {
	process.env.HOME = savedHome;
	while (tmpDirs.length) {
		await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {});
	}
});

describe("flywheel: loop → journal → training row", () => {
	it("safe session exports one valid unlabeled row (no drop)", async () => {
		await tmpHome();
		const journal = await Journal.open("flywheel-safe");
		const report = await runAuditLoop(VAULT_CODE, {
			agent: fakeAgent(SAFE_REPLY),
			pocTool: stubPocTool(""),
			journal,
			systemPrompt: SYSTEM_PROMPT,
		});
		expect(report.safeVerdict).toBe(true);
		await journal.close({ verified: 0 });

		const { rows, dropped, warnings } = await exportSession(journal.session.eventsPath);
		expect(dropped).toBe(0);
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.metadata.label).toBe("unlabeled");
		expect(validateRow(row)).toEqual([]);
		expect(row.messages[0]).toMatchObject({ role: "system", content: SYSTEM_PROMPT });
		expect(row.messages[1].role).toBe("user");
		expect(String(row.messages[1].content)).toContain(VAULT_CODE);
		const assistant = row.messages.filter((m) => m.role === "assistant");
		expect(assistant.some((m) => String(m.content).includes("safe"))).toBe(true);
		expect(warnings).toEqual([]);
	});

	it.skipIf(!hasFoundry)(
		"verified session exports a gold_positive row with a fork.verify tool pair",
		async () => {
			await tmpHome();
			const poc = readFileSync("examples/poc-reentrancy.sol", "utf-8");
			const anvil: AnvilHandle = await startAnvil();
			try {
				const journal = await Journal.open("flywheel-verified");
				const report = await runAuditLoop(VAULT_CODE, {
					agent: fakeAgent(FINDING_REPLY),
					pocTool: stubPocTool(poc),
					journal,
					anvil,
					systemPrompt: SYSTEM_PROMPT,
				});
				expect(report.verifiedFindings).toHaveLength(1);
				await journal.close({ verified: report.verifiedFindings.length });

				const { rows, dropped } = await exportSession(journal.session.eventsPath);
				expect(dropped).toBe(0);
				expect(rows).toHaveLength(1);
				const [row] = rows;
				expect(row.metadata.label).toBe("gold_positive");
				expect(validateRow(row)).toEqual([]);

				const callIdx = row.messages.findIndex((m) => m.role === "assistant" && m.tool_calls?.length);
				expect(callIdx).toBeGreaterThan(-1);
				const call = row.messages[callIdx].tool_calls![0];
				expect(call.function.name).toBe("execute_code");
				const args = JSON.parse(call.function.arguments) as { code: string };
				expect(args.code).toContain("contract");
				const result = row.messages[callIdx + 1];
				expect(result.role).toBe("tool");
				expect(result.tool_call_id).toBe(call.id);
				expect(String(result.content)).toContain("verified");

				// The finding prose must survive into the row (full-text journaling).
				const auditMsg = row.messages.find(
					(m) => m.role === "assistant" && String(m.content).includes("Reentrancy in withdraw()"),
				);
				expect(auditMsg).toBeDefined();
			} finally {
				await anvil.kill();
			}
		},
		340_000,
	);
});
