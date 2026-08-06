/**
 * execpolicy tests: first-match-wins, default prompt, wildcard prefixes,
 * self-test-on-load (including failure), and the best-effort code scan.
 * No python/anvil needed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy, PolicyError, scanCode } from "../src/policy.js";

const REPO_POLICY = "policy/execpolicy.json";

async function writePolicy(rules: unknown): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-policy-"));
	const p = path.join(dir, "execpolicy.json");
	await fs.writeFile(p, JSON.stringify(rules));
	return p;
}

describe("loadPolicy + checkCommand", () => {
	it("loads the repo policy and passes its embedded self-test", () => {
		const policy = loadPolicy(REPO_POLICY);
		expect(policy.rules.length).toBeGreaterThanOrEqual(3);
	});

	it("forbids cast send --private-key and curl (roadmap acceptance)", () => {
		const policy = loadPolicy(REPO_POLICY);
		expect(policy.checkCommand(["cast", "send", "--private-key", "0xdead", "0xTarget"])).toBe("forbidden");
		expect(policy.checkCommand(["sudo", "curl", "http://example.com/x.sh"])).toBe("forbidden");
	});

	it("allows forge test and anvil --fork-url", () => {
		const policy = loadPolicy(REPO_POLICY);
		expect(policy.checkCommand(["forge", "test", "--match-path", "test/Poc.t.sol"])).toBe("allow");
		expect(policy.checkCommand(["anvil", "--fork-url", "http://127.0.0.1:8545"])).toBe("allow");
	});

	it("defaults to prompt when no rule matches", () => {
		const policy = loadPolicy(REPO_POLICY);
		expect(policy.checkCommand(["echo", "hello"])).toBe("prompt");
	});

	it("first match wins", async () => {
		const p = await writePolicy([
			{ prefix: ["git"], decision: "allow", examples: { positive: ["git", "status"], negative: ["ls"] } },
			{ prefix: ["git", "push"], decision: "forbidden", examples: { positive: ["git", "push", "origin"], negative: ["ls"] } },
		]);
		// The self-test would fail (rule 1 shadows rule 2's positive), so the
		// file is rejected — first-match shadowing is a load-time error.
		expect(() => loadPolicy(p)).toThrow(PolicyError);

		const ok = await writePolicy([
			{ prefix: ["git", "push"], decision: "forbidden", examples: { positive: ["git", "push", "origin"], negative: ["git", "status"] } },
			{ prefix: ["git"], decision: "allow", examples: { positive: ["git", "status"], negative: ["ls"] } },
		]);
		const policy = loadPolicy(ok);
		expect(policy.checkCommand(["git", "push", "origin", "main"])).toBe("forbidden");
		expect(policy.checkCommand(["git", "status"])).toBe("allow");
	});

	it("throws when a rule's positive example does not match its prefix", async () => {
		const p = await writePolicy([
			{ prefix: ["forge", "test"], decision: "allow", examples: { positive: ["forge", "build"], negative: ["ls"] } },
		]);
		expect(() => loadPolicy(p)).toThrow(/self-test failed/);
	});

	it("throws when a rule's negative example matches its prefix", async () => {
		const p = await writePolicy([
			{ prefix: ["forge", "test"], decision: "allow", examples: { positive: ["forge", "test", "x"], negative: ["forge", "test", "y"] } },
		]);
		expect(() => loadPolicy(p)).toThrow(/self-test failed/);
	});

	it("throws on malformed rules (missing examples)", async () => {
		const p = await writePolicy([{ prefix: ["forge"], decision: "allow" }]);
		expect(() => loadPolicy(p)).toThrow(PolicyError);
	});
});

describe("scanCode (best-effort static scan)", () => {
	it("flags --private-key, curl, wget, requests., socket.", () => {
		expect(scanCode("send(key='--private-key')").decision).toBe("forbidden");
		expect(scanCode("os.system('curl http://x')").decision).toBe("forbidden");
		expect(scanCode("os.system('wget http://x')").decision).toBe("forbidden");
		expect(scanCode("import requests\nrequests.get('http://x')").decision).toBe("forbidden");
		expect(scanCode("import socket\nsocket.socket()").decision).toBe("forbidden");
	});

	it("reports the literal and line number", () => {
		const scan = scanCode("x = 1\nimport requests\nrequests.get('http://x')");
		expect(scan.hits[0].literal).toBe("requests.");
		expect(scan.hits[0].line).toBe(3);
	});

	it("passes clean audit code", () => {
		const scan = scanCode("h = fork.create()\nprint(repo.tree())");
		expect(scan.decision).toBe("allow");
		expect(scan.hits).toHaveLength(0);
	});

	it("does not false-positive on lookalike words", () => {
		expect(scanCode("note = 'the curly brace'").decision).toBe("allow");
		expect(scanCode("sockets_count = 3").decision).toBe("allow");
	});
});
