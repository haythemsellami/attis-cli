/**
 * Tests for the findings parser. Synthetic fixtures only — eval data never
 * crosses into this repo (AGENTS.md boundary).
 */
import { describe, expect, it } from "vitest";
import { parseFindings } from "../src/findings.js";

const SINGLE = `## Findings

### [High] Reentrancy in withdraw()

**Impact:** An attacker can drain the contract's entire ETH balance by re-entering withdraw() before the balance is zeroed.

**Proof of Concept:**
\`\`\`
contract Attack { function attack() external { vault.withdraw(); } }
\`\`\`

**Remediation:** Apply checks-effects-interactions: zero the balance before the external call.`;

const MULTI = `## Findings

### [High] Oracle manipulation via stale price
**Impact:** Attacker drains reserves with outdated prices.

### [Medium] Missing zero-address check in setOwner
**Impact:** Ownership can be lost permanently.
**Remediation:** Require newOwner != address(0).

### [Low] Gas griefing via unbounded loop
**Impact:** Calls may run out of gas.`;

describe("parseFindings", () => {
	it("parses a single finding with all sections", () => {
		const r = parseFindings(SINGLE);
		expect(r.unparseable).toBe(false);
		expect(r.isSafe).toBe(false);
		expect(r.findings).toHaveLength(1);
		const f = r.findings[0];
		expect(f.severity).toBe("High");
		expect(f.title).toBe("Reentrancy in withdraw()");
		expect(f.impact).toContain("drain the contract");
		expect(f.poc).toContain("contract Attack");
		expect(f.remediation).toContain("checks-effects-interactions");
	});

	it("parses multiple findings in order with severities", () => {
		const r = parseFindings(MULTI);
		expect(r.findings.map((f) => f.severity)).toEqual(["High", "Medium", "Low"]);
		expect(r.findings[0].impact).toContain("drains reserves");
		expect(r.findings[1].remediation).toContain("address(0)");
		expect(r.findings[2].title).toBe("Gas griefing via unbounded loop");
	});

	it("detects safe verdicts", () => {
		for (const body of [
			"No issues found.\n\nWhy it is safe: checks are in place.",
			"After reviewing the code, I found no vulnerabilities.",
			"The code is safe.",
		]) {
			const r = parseFindings(body);
			expect(r.isSafe).toBe(true);
			expect(r.findings).toHaveLength(0);
			expect(r.unparseable).toBe(false);
		}
	});

	it("flags unparseable output strictly (no salvage)", () => {
		const r = parseFindings(
			"The user wants me to audit the provided code. I looked at it for a while.",
		);
		expect(r.unparseable).toBe(true);
		expect(r.findings).toHaveLength(0);
		expect(r.isSafe).toBe(false);
	});

	it("normalizes single-letter and QA severities", () => {
		const r = parseFindings(
			"### [H] Bug one\n\n**Impact:** x\n\n### [QA] Nit two\n\n**Impact:** y",
		);
		expect(r.findings.map((f) => f.severity)).toEqual(["High", "Low"]);
	});

	it("strips trailing asterisks from titles", () => {
		const r = parseFindings("### [Medium] Some bug title**\n\n**Impact:** x");
		expect(r.findings[0].title).toBe("Some bug title");
	});

	it("keeps the finding's raw section for the journal", () => {
		const r = parseFindings(SINGLE);
		expect(r.findings[0].raw).toContain("Reentrancy");
		expect(r.findings[0].raw).toContain("Proof of Concept");
	});
});
