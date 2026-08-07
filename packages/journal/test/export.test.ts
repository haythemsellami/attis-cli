/**
 * journal export tests (roadmap v2 item 5) — fixture events.jsonl files:
 * a full verified session (gold_positive), failed verification (hard_negative),
 * kernel_exec pairs across a restart, a policy-blocked exec, an unlabeled
 * session, a v1 chars-only session (dropped, no silent salvage), validator
 * rejections, and batch export over a manifest / a sessions directory.
 * No model, no anvil — the journal is the only input.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	contentHash,
	DEFAULT_SYSTEM_PROMPT,
	exportRollout,
	exportSession,
	safeName,
	validateRow,
	type ChatMessage,
	type TrainingRow,
} from "../src/index.js";

let root: string;
beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-export-"));
});
afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** Deterministic timestamps per fixture (first event is always :00). */
function stamper() {
	let n = 0;
	return (type: string, data: Record<string, unknown>) =>
		JSON.stringify({ ts: `2026-08-06T00:00:${String(n++).padStart(2, "0")}.000Z`, type, data });
}

async function writeSession(dir: string, sessionId: string, lines: string[]): Promise<string> {
	const sessionDir = path.join(dir, sessionId);
	await fs.mkdir(sessionDir, { recursive: true });
	const eventsPath = path.join(sessionDir, "events.jsonl");
	await fs.writeFile(eventsPath, lines.join("\n") + "\n");
	return eventsPath;
}

function kernelExec(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { code, ok: true, result: null, error: null, stdout: "", stderr: "", duration_ms: 5, ...extra };
}

function goldSession(workdir: string): string[] {
	const ev = stamper();
	return [
		ev("session_start", { workdir }),
		ev("audit_prompt", {
			chars: 512,
			system: "You are Orgia, an expert EVM auditor.",
			prompt: "Audit this contract:\n\n```solidity\ncontract Vault { function withdraw() external {} }\n```",
		}),
		ev("kernel_exec", kernelExec("repo.tree()", { result: "['Vault.sol']" })),
		ev("kernel_exec", kernelExec("repo.read('Vault.sol')", { result: "contract Vault ..." })),
		ev("audit_result", {
			output_chars: 96,
			output: "### [High] Reentrancy in Vault.withdraw\n**Impact:** attacker drains the vault.",
		}),
		ev("findings_parsed", { count: 1, isSafe: false, unparseable: false }),
		ev("poc_generated", {
			title: "Reentrancy in Vault.withdraw", attempt: 0, poc_chars: 64,
			code: "contract Exploit { function attack() external { vault.withdraw(); } }",
		}),
		ev("fork_verdict", {
			title: "Reentrancy in Vault.withdraw", attempt: 0, verified: true,
			trace: "PoC passed: vault balance drained",
		}),
		ev("finding_kept", { title: "Reentrancy in Vault.withdraw", severity: "High" }),
		ev("report", {
			verified: 1, dropped: 0,
			text: "## Findings\n\n### [High] Reentrancy in Vault.withdraw\nVerified on fork.",
		}),
		ev("session_end", { verified: 1 }),
	];
}

function failedSession(workdir: string): string[] {
	const ev = stamper();
	return [
		ev("session_start", { workdir }),
		ev("audit_prompt", { chars: 300, prompt: "Audit this contract:\n\n```solidity\ncontract Token {}\n```" }),
		ev("kernel_exec", kernelExec("repo.read('Token.sol')", { result: "contract Token ..." })),
		ev("audit_result", { output: "### [Medium] Suspicious mint\n**Impact:** supply inflation." }),
		ev("findings_parsed", { count: 1, isSafe: false, unparseable: false }),
		ev("poc_generated", { title: "Suspicious mint", attempt: 0, code: "contract Exploit0 {}" }),
		ev("fork_verdict", { title: "Suspicious mint", attempt: 0, verified: false, trace: "reverted: Ownable" }),
		ev("poc_generated", { title: "Suspicious mint", attempt: 1, code: "contract Exploit1 {}" }),
		ev("fork_verdict", { title: "Suspicious mint", attempt: 1, verified: false, trace: "reverted: Ownable" }),
		ev("finding_dropped", { title: "Suspicious mint", reason: "verification_failed" }),
		ev("report", { verified: 0, dropped: 1, text: "## Findings\n\nNo verified findings." }),
		ev("session_end", {}),
	];
}

function unlabeledSession(workdir: string): string[] {
	const ev = stamper();
	return [
		ev("session_start", { workdir }),
		ev("audit_prompt", { chars: 128, prompt: "Audit this contract:\n\n```solidity\ncontract Safe {}\n```" }),
		ev("kernel_exec", kernelExec("repo.tree()", { result: "['Safe.sol']" })),
		ev("audit_result", {
			output_chars: 40,
			output: "No issues found. Checks-effects-interactions is followed.",
		}),
		ev("findings_parsed", { count: 0, isSafe: true, unparseable: false }),
		ev("report", { verified: 0, dropped: 0, safe: true, text: "No issues found." }),
		ev("session_end", {}),
	];
}

describe("exportSession", () => {
	it("exports a verified session as a gold_positive row in the native wire", async () => {
		const workdir = "/repos/alpha";
		const eventsPath = await writeSession(path.join(root, "gold"), "sess-gold", goldSession(workdir));
		const out = await exportSession(eventsPath);

		expect(out.dropped).toBe(0);
		expect(out.warnings).toEqual([]);
		expect(out.rows).toHaveLength(1);
		const row = out.rows[0];

		expect(row.messages.map((m) => m.role)).toEqual([
			"system", "user",
			"assistant", "tool",
			"assistant", "tool",
			"assistant",
			"assistant", "tool",
			"assistant",
		]);
		expect(row.messages[0].content).toBe("You are Orgia, an expert EVM auditor.");
		expect(row.messages[1].content).toContain("Audit this contract");

		// kernel_exec → assistant tool_call + tool result, stable call ids
		const call0 = row.messages[2].tool_calls![0];
		expect(call0).toMatchObject({ id: "call_0", type: "function" });
		expect(call0.function.name).toBe("execute_code");
		expect(JSON.parse(call0.function.arguments) as { code: string }).toEqual({ code: "repo.tree()" });
		expect(row.messages[3].tool_call_id).toBe("call_0");
		const result0 = JSON.parse(row.messages[3].content) as { ok: boolean; result: string };
		expect(result0.ok).toBe(true);
		expect(result0.result).toBe("['Vault.sol']");

		// audit analysis is plain assistant content
		expect(row.messages[6].content).toContain("### [High] Reentrancy in Vault.withdraw");
		expect(row.messages[6].tool_calls).toBeUndefined();

		// poc_generated + fork_verdict → assistant tool_call pair, verdict as tool result
		const pocMsg = row.messages[7];
		expect(pocMsg.content).toContain('PoC for "Reentrancy in Vault.withdraw" (attempt 0)');
		expect(pocMsg.tool_calls![0].id).toBe("call_2");
		const verdict = JSON.parse(row.messages[8].content) as { ok: boolean; verified: boolean; trace: string };
		expect(row.messages[8].tool_call_id).toBe("call_2");
		expect(verdict).toMatchObject({ ok: true, verified: true, trace: "PoC passed: vault balance drained" });

		// report is the final assistant message
		expect(row.messages[9].content).toContain("## Findings");

		expect(row.metadata).toEqual({
			session_id: "sess-gold",
			repo_hash: contentHash(workdir),
			source: "attis-rollout",
			ts: "2026-08-06T00:00:00.000Z",
			label: "gold_positive",
			verified_findings: 1,
			dropped_findings: 0,
			kernel_execs: 2,
		});
		expect(validateRow(row)).toEqual([]);
	});

	it("labels an exhausted-verification session as hard_negative", async () => {
		const eventsPath = await writeSession(path.join(root, "failed"), "sess-failed", failedSession("/repos/beta"));
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		expect(out.warnings).toEqual([]);
		const row = out.rows[0];
		expect(row.metadata.label).toBe("hard_negative");
		expect(row.metadata.verified_findings).toBe(0);
		expect(row.metadata.dropped_findings).toBe(1);
		// no system journaled → orgia-llm default prompt
		expect(row.messages[0].content).toBe(DEFAULT_SYSTEM_PROMPT);
		// both attempts exported as tool_call pairs with failing verdicts
		const toolResults = row.messages.filter((m) => m.role === "tool");
		expect(toolResults).toHaveLength(3); // 1 kernel + 2 fork attempts
		for (const t of toolResults.slice(1)) {
			expect((JSON.parse(t.content) as { ok: boolean; verified: boolean })).toMatchObject({
				ok: false, verified: false,
			});
		}
		expect(validateRow(row)).toEqual([]);
	});

	it("maps kernel_exec pairs across a kernel restart (restart rides the exec result)", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(path.join(root, "restart"), "sess-restart", [
			ev("session_start", { workdir: "/repos/gamma" }),
			ev("audit_prompt", { prompt: "Audit this contract:\n\n```solidity\ncontract X {}\n```" }),
			ev("kernel_exec", kernelExec("x = 1")),
			ev("kernel_restart", { reason: "sidecar died; fresh namespace" }),
			ev("kernel_exec", kernelExec("print(x)", {
				ok: false,
				error: { type: "NameError", message: "name 'x' is not defined" },
				restarted: true,
			})),
			ev("report", { text: "Kernel died mid-audit; partial notes only." }),
			ev("session_end", {}),
		]);
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		const row = out.rows[0];
		// system, user, 2×(assistant, tool), final assistant — kernel_restart adds no message
		expect(row.messages.map((m) => m.role)).toEqual([
			"system", "user", "assistant", "tool", "assistant", "tool", "assistant",
		]);
		const restarted = JSON.parse(row.messages[5].content) as {
			ok: boolean; restarted: boolean; note: string; error: { type: string };
		};
		expect(restarted.ok).toBe(false);
		expect(restarted.restarted).toBe(true);
		expect(restarted.note).toContain("restarted");
		expect(restarted.error.type).toBe("NameError");
		expect(row.metadata.label).toBe("unlabeled");
		expect(validateRow(row)).toEqual([]);
	});

	it("maps a policy-blocked exec to a blocked tool result", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(path.join(root, "blocked"), "sess-blocked", [
			ev("session_start", { workdir: "/repos/delta" }),
			ev("audit_prompt", { prompt: "Audit this contract:\n\n```solidity\ncontract Y {}\n```" }),
			ev("kernel_exec", {
				blocked: true,
				policy_hits: ["curl (line 2)"],
				code: "import subprocess\nsubprocess.run(['curl', 'http://evil.example'])",
			}),
			ev("audit_result", { output: "Network access is blocked; switching to fork helpers." }),
		]);
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		const toolMsg = out.rows[0].messages.find((m) => m.role === "tool")!;
		const payload = JSON.parse(toolMsg.content) as { ok: boolean; blocked: boolean; reason: string };
		expect(payload.ok).toBe(false);
		expect(payload.blocked).toBe(true);
		expect(payload.reason).toContain("execpolicy forbids: curl (line 2)");
		expect(validateRow(out.rows[0])).toEqual([]);
	});

	it("exports sessions without verdicts as unlabeled", async () => {
		const eventsPath = await writeSession(path.join(root, "plain"), "sess-plain", unlabeledSession("/repos/epsilon"));
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		expect(out.dropped).toBe(0);
		expect(out.rows[0].metadata.label).toBe("unlabeled");
		expect(validateRow(out.rows[0])).toEqual([]);
	});

	it("drops v1 chars-only sessions with warnings (no silent salvage)", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(path.join(root, "v1"), "sess-v1", [
			ev("session_start", { workdir: "/repos/zeta" }),
			ev("audit_prompt", { chars: 512 }),
			ev("kernel_exec", kernelExec("repo.tree()", { result: "[]" })),
			ev("audit_result", { output_chars: 200 }),
			ev("findings_parsed", { count: 1, isSafe: false, unparseable: false }),
			ev("poc_generated", { title: "X", attempt: 0, poc_chars: 64 }),
			ev("fork_verdict", { title: "X", attempt: 0, verified: true, trace: "passed" }),
			ev("finding_kept", { title: "X", severity: "High" }),
			ev("report", { verified: 1, dropped: 0 }),
		]);
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(0);
		expect(out.dropped).toBe(1);
		expect(out.warnings.some((w) => w.includes("no prompt text"))).toBe(true);
		expect(out.warnings.some((w) => w.includes("carries no code"))).toBe(true);
		expect(out.warnings.some((w) => w.includes("user message has empty content"))).toBe(true);
	});

	it("skips kernel_exec events without code and keeps the row", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(path.join(root, "nocode"), "sess-nocode", [
			ev("session_start", { workdir: "/repos/eta" }),
			ev("audit_prompt", { prompt: "Audit this contract:\n\n```solidity\ncontract Z {}\n```" }),
			ev("kernel_exec", { ok: true }),
			ev("audit_result", { output: "Analysis without tool calls." }),
		]);
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		expect(out.warnings.some((w) => w.includes("kernel_exec without code"))).toBe(true);
		expect(out.rows[0].messages.some((m) => m.role === "tool")).toBe(false);
		expect(out.rows[0].metadata.kernel_execs).toBe(0);
	});

	it("tolerates malformed NDJSON lines", async () => {
		const lines = unlabeledSession("/repos/theta");
		lines.splice(2, 0, "{not json");
		const eventsPath = await writeSession(path.join(root, "malformed"), "sess-bad", lines);
		const out = await exportSession(eventsPath);

		expect(out.rows).toHaveLength(1);
		expect(out.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
	});
});

describe("validateRow", () => {
	function mkRow(messages: ChatMessage[]): TrainingRow {
		return {
			messages,
			metadata: {
				session_id: "s", repo_hash: "h", source: "attis-rollout", ts: "t",
				label: "unlabeled", verified_findings: 0, dropped_findings: 0, kernel_execs: 0,
			},
		};
	}
	const toolCall = (id: string, args = '{"code": "1"}') => ({
		id, type: "function" as const, function: { name: "execute_code", arguments: args },
	});

	it("accepts minimal and tool-exchange rows", () => {
		expect(validateRow(mkRow([
			{ role: "system", content: "s" },
			{ role: "user", content: "u" },
			{ role: "assistant", content: "done" },
		]))).toEqual([]);
		expect(validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "", tool_calls: [toolCall("call_0")] },
			{ role: "tool", tool_call_id: "call_0", content: "{}" },
			{ role: "assistant", content: "done" },
		]))).toEqual([]);
	});

	it("rejects a tool result without a preceding tool_call", () => {
		const problems = validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "tool", tool_call_id: "call_0", content: "{}" },
		]));
		expect(problems.some((p) => p.includes("no preceding tool_call"))).toBe(true);
	});

	it("rejects a tool result answering a stale or foreign call id", () => {
		const problems = validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "", tool_calls: [toolCall("call_0")] },
			{ role: "tool", tool_call_id: "call_9", content: "{}" },
		]));
		expect(problems.some((p) => p.includes("call_9"))).toBe(true);
	});

	it("rejects a second user message after the prompt", () => {
		const problems = validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "late" },
		]));
		expect(problems.some((p) => p.includes("not allowed after the prompt"))).toBe(true);
	});

	it("rejects tool_call arguments that are not valid JSON", () => {
		const problems = validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "", tool_calls: [toolCall("call_0", "not json")] },
		]));
		expect(problems.some((p) => p.includes("not valid JSON"))).toBe(true);
	});

	it("rejects empty assistant content and rows without any assistant message", () => {
		expect(validateRow(mkRow([
			{ role: "user", content: "u" },
			{ role: "assistant", content: "" },
		])).some((p) => p.includes("empty content"))).toBe(true);
		expect(validateRow(mkRow([
			{ role: "system", content: "s" },
			{ role: "user", content: "u" },
		])).some((p) => p.includes("no assistant message"))).toBe(true);
	});
});

describe("exportRollout", () => {
	it("batch-exports a rollout manifest (done repos only, failures are warnings)", async () => {
		const dir = path.join(root, "batch");
		const goldPath = await writeSession(dir, "sess-gold", goldSession("/repos/alpha"));
		await writeSession(dir, "sess-plain", unlabeledSession("/repos/beta"));
		const manifestPath = path.join(dir, ".attis-rollout.json");
		await fs.writeFile(manifestPath, JSON.stringify({
			repos: [
				{ path: "/repos/alpha", status: "done", eventsPath: goldPath },
				{ path: "/repos/beta", status: "done", eventsPath: "sess-plain/events.jsonl" }, // relative to manifest
				{ path: "/repos/gamma", status: "pending" },
				{ path: "/repos/delta", status: "failed" },
				{ path: "/repos/epsilon", status: "done", eventsPath: path.join(dir, "missing", "events.jsonl") },
			],
		}));
		const out = await exportRollout(manifestPath);

		expect(out.sessions).toBe(2);
		expect(out.rows).toHaveLength(2);
		expect(out.dropped).toBe(0);
		expect(out.rows.map((r) => r.metadata.label)).toEqual(["gold_positive", "unlabeled"]);
		expect(out.warnings.some((w) => w.includes("missing"))).toBe(true);
	});

	it("resolves manifest sessions via ~/.attis when eventsPath is absent", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "attis-home-"));
		vi.stubEnv("HOME", home);
		try {
			const repoPath = "/repos/DAO";
			await writeSession(
				path.join(home, ".attis", "sessions", safeName(repoPath)),
				"sess-123",
				unlabeledSession(repoPath),
			);
			const manifestPath = path.join(home, ".attis-rollout.json");
			await fs.writeFile(manifestPath, JSON.stringify({
				repos: [{ path: repoPath, status: "done", sessionId: "sess-123" }],
			}));
			const out = await exportRollout(manifestPath);

			expect(out.sessions).toBe(1);
			expect(out.rows).toHaveLength(1);
			expect(out.rows[0].metadata.session_id).toBe("sess-123");
			expect(out.rows[0].metadata.repo_hash).toBe(contentHash(repoPath));
		} finally {
			vi.unstubAllEnvs();
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("accepts the record-shaped manifest written by attis rollout", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "attis-home-"));
		vi.stubEnv("HOME", home);
		try {
			const repoPath = "/repos/Record";
			await writeSession(
				path.join(home, ".attis", "sessions", safeName(repoPath)),
				"sess-rec",
				goldSession(repoPath),
			);
			const manifestPath = path.join(home, ".attis-rollout.json");
			await fs.writeFile(manifestPath, JSON.stringify({
				version: 1,
				repos: {
					[repoPath]: { status: "done", sessionId: "sess-rec", verified: 1 },
					"/repos/other": { status: "failed", error: "agent crashed" },
					"/repos/queued": { status: "pending" },
				},
			}));
			const out = await exportRollout(manifestPath);

			expect(out.sessions).toBe(1);
			expect(out.rows).toHaveLength(1);
			expect(out.rows[0].metadata.label).toBe("gold_positive");
			expect(out.rows[0].metadata.session_id).toBe("sess-rec");
			expect(out.rows[0].metadata.repo_hash).toBe(contentHash(repoPath));
		} finally {
			vi.unstubAllEnvs();
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("resolves record-manifest relative keys against the manifest dir", async () => {
		// Regression: attis rollout keys repos by path RELATIVE to the repos
		// root, but journals live under safeName(<absolute repo path>) —
		// resolution must join with the manifest's own directory first.
		const reposRoot = path.join(root, "real-rollout");
		const repoDir = path.join(reposRoot, "repo-a");
		await fs.mkdir(repoDir, { recursive: true });
		const home = path.join(root, "home-rel");
		vi.stubEnv("HOME", home);
		const eventsPath = await writeSession(
			path.join(home, ".attis", "sessions", safeName(repoDir)),
			"sess-rel",
			goldSession(repoDir),
		);
		const manifestPath = path.join(reposRoot, ".attis-rollout.json");
		await fs.writeFile(
			manifestPath,
			JSON.stringify({ version: 1, repos: { "repo-a": { status: "done", sessionId: "sess-rel" } } }),
		);
		try {
			const out = await exportRollout(manifestPath);
			expect(out.warnings).toEqual([]);
			expect(out.sessions).toBe(1);
			expect(out.rows).toHaveLength(1);
			expect(out.rows[0].metadata.label).toBe("gold_positive");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("walks a sessions directory", async () => {
		const dir = path.join(root, "walk");
		await writeSession(dir, "alpha/sess-1", goldSession("/repos/alpha"));
		await writeSession(dir, "beta/sess-2", unlabeledSession("/repos/beta"));
		const out = await exportRollout(dir);

		expect(out.sessions).toBe(2);
		expect(out.rows).toHaveLength(2);
		expect(out.rows.map((r) => r.metadata.label)).toEqual(["gold_positive", "unlabeled"]);
		expect(out.rows.map((r) => r.metadata.session_id)).toEqual(["sess-1", "sess-2"]);
	});

	it("reports an unreadable rollout path as a warning", async () => {
		const out = await exportRollout(path.join(root, "does-not-exist"));
		expect(out.rows).toHaveLength(0);
		expect(out.sessions).toBe(0);
		expect(out.warnings.some((w) => w.includes("not found"))).toBe(true);
	});
});

describe("kernel fork.verify markers (repo-mode ground truth)", () => {
	/** Repo-mode sessions: no poc_generated/fork_verdict events — verification
	 *  happens agent-side in the kernel and lands as stdout markers. */
	function repoModeSession(workdir: string, verdict: string): string[] {
		const ev = stamper();
		return [
			ev("session_start", { workdir }),
			ev("audit_prompt", { chars: 55, system: "SYS", prompt: "Audit this Solidity repo…" }),
			ev("kernel_exec", kernelExec("repo.tree()", { stdout: '{"files":["src/Vault.sol"]}\n' })),
			ev(
				"kernel_exec",
				kernelExec('fork.verify(poc, {"setup": setup})', {
					stdout: `ATTIS_FORK_VERDICT {"verdict": "${verdict}", "raw_log_path": "/tmp/x/forge-output.log"}\n{"verdict": "${verdict}"}\n`,
				}),
			),
			ev("audit_result", { output_chars: 80, output: "### [Critical] Reentrancy in withdraw()" }),
			ev("findings_parsed", { count: 1, isSafe: false, unparseable: false }),
			ev("report", { verified: 0, dropped: 0, parsed: 1, agentVerified: true }),
			ev("session_end", { verified: 0, findings: 1 }),
		];
	}

	it("labels a kernel-verified repo session gold_positive", async () => {
		const eventsPath = await writeSession(root, "marker-gold", repoModeSession("/repos/v", "verified"));
		const { rows, dropped } = await exportSession(eventsPath);
		expect(dropped).toBe(0);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata.label).toBe("gold_positive");
		expect(validateRow(rows[0])).toEqual([]);
	});

	it("labels a failed kernel verification hard_negative", async () => {
		const eventsPath = await writeSession(root, "marker-hard", repoModeSession("/repos/v", "reverted"));
		const { rows, dropped } = await exportSession(eventsPath);
		expect(dropped).toBe(0);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata.label).toBe("hard_negative");
	});

	it("treats the marker's additive mode field as opaque", async () => {
		// fork.verify gained "mode" ("repo"|"template") and "era"; the
		// exporter reads only verdict/raw_log_path and must keep labeling
		// as before.
		const ev = stamper();
		const eventsPath = await writeSession(root, "marker-mode", [
			ev("session_start", { workdir: "/repos/v" }),
			ev("audit_prompt", { chars: 10, prompt: "p", system: "s" }),
			ev(
				"kernel_exec",
				kernelExec("fork.verify(poc)", {
					stdout: 'ATTIS_FORK_VERDICT {"verdict": "verified", "raw_log_path": "/x", "mode": "repo", "era": "v4"}\n',
				}),
			),
			ev("audit_result", { output_chars: 10, output: "analysis" }),
			ev("session_end", {}),
		]);
		const { rows, dropped, warnings } = await exportSession(eventsPath);
		expect(dropped).toBe(0);
		expect(rows[0].metadata.label).toBe("gold_positive");
		expect(warnings.some((w) => w.includes("malformed ATTIS_FORK_VERDICT"))).toBe(false);
	});

	it("ignores malformed markers and stays unlabeled", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(root, "marker-bad", [
			ev("session_start", { workdir: "/repos/v" }),
			ev("audit_prompt", { chars: 10, prompt: "p", system: "s" }),
			ev("kernel_exec", kernelExec("fork.verify(poc)", { stdout: "ATTIS_FORK_VERDICT {not json}\n" })),
			ev("audit_result", { output_chars: 10, output: "analysis" }),
			ev("session_end", {}),
		]);
		const { rows, warnings } = await exportSession(eventsPath);
		expect(rows[0].metadata.label).toBe("unlabeled");
		expect(warnings.some((w) => w.includes("malformed ATTIS_FORK_VERDICT"))).toBe(true);
	});

	it("skips pre-prompt kernel_exec (harness setup in pre-repo_inventory journals)", async () => {
		const ev = stamper();
		const eventsPath = await writeSession(root, "pre-prompt", [
			ev("session_start", { workdir: "/repos/v" }),
			ev("kernel_exec", kernelExec("repo.tree()", { stdout: '{"files":["Vault.sol"]}\n' })),
			ev("audit_prompt", { chars: 10, system: "SYS", prompt: "Audit this repo…" }),
			ev(
				"kernel_exec",
				kernelExec("fork.verify(poc)", {
					stdout: 'ATTIS_FORK_VERDICT {"verdict": "verified", "raw_log_path": "/x"}\n',
				}),
			),
			ev("audit_result", { output_chars: 10, output: "### [High] Reentrancy" }),
			ev("session_end", {}),
		]);
		const { rows, dropped, warnings } = await exportSession(eventsPath);
		expect(dropped).toBe(0);
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata.label).toBe("gold_positive");
		expect(validateRow(rows[0])).toEqual([]);
		expect(rows[0].messages[1].role).toBe("user");
		expect(warnings.some((w) => w.includes("before the audit prompt"))).toBe(true);
		// The skipped setup exec must not appear as a model action.
		const calls = rows[0].messages.flatMap((m) => m.tool_calls ?? []);
		expect(calls.some((c) => c.function.arguments.includes("repo.tree()"))).toBe(false);
	});
});
