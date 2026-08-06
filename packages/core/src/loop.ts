/**
 * The v1 audit loop (roadmap item 4):
 * audit → parse → per finding (severity order): generate_poc → fork_verify
 * (≤2 retries, revert trace as next constraint) → verified-only report.
 *
 * The agent does the free-reasoning audit phase; the verification loop is
 * deterministic — no findings ship without a forge test passing on-chain.
 */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { parseFindings, type Finding, type Severity } from "./findings.js";
import { startAnvil, runPocOnAnvil, type AnvilHandle, type ForkVerdict } from "@attis/fork";
import { Journal } from "@attis/journal";

export interface LoopOptions {
	agent: Agent;
	pocTool: AgentTool<any>;
	journal: Journal;
	anvil?: AnvilHandle;
	maxRetriesPerFinding?: number;
	/** Repo rollouts replace the single-contract prompt with the inventory prompt. */
	auditPrompt?: string;
	/** Journaled with audit_prompt so exports can rebuild the full system message. */
	systemPrompt?: string;
	/** Set false for repo rollouts: the agent verifies through kernel
	 *  fork.verify (harness-executed); the deterministic phase below is the
	 *  single-contract path and would fail on missing repo files. */
	deterministicVerify?: boolean;
	onEvent?: (event: Record<string, unknown>) => void;
}

export interface VerifiedFinding extends Finding {
	verified: true;
	pocCode: string;
	verdict: ForkVerdict;
}

export interface LoopReport {
	verifiedFindings: VerifiedFinding[];
	dropped: { finding: Finding; reason: string }[];
	safeVerdict: boolean;
	unparseable: boolean;
	/** Findings parsed from the audit output (0 when safe/unparseable). */
	parsedCount: number;
}

const SEV_ORDER: Record<Severity, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };

function assistantText(agent: Agent): string {
	const msgs = agent.state.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; content?: unknown };
		if (m.role === "assistant" && Array.isArray(m.content)) {
			return (m.content as { type: string; text?: string }[])
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text!)
				.join("\n");
		}
	}
	return "";
}

export async function runAuditLoop(code: string, opts: LoopOptions): Promise<LoopReport> {
	const { agent, pocTool, journal } = opts;
	const emit = (event: Record<string, unknown>) => opts.onEvent?.(event);
	const maxRetries = opts.maxRetriesPerFinding ?? 2;

	// --- audit phase ---
	// Full-text journaling: the item-5 exporter rebuilds training rows from
	// these payloads — char counts alone would make the row drop.
	const prompt = opts.auditPrompt ?? `Audit this contract:\n\n\`\`\`solidity\n${code}\n\`\`\``;
	await journal.write("audit_prompt", {
		chars: code.length, prompt, ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
	});
	emit({ type: "step", step: "audit" });
	await agent.prompt(prompt);
	await agent.waitForIdle();

	const output = assistantText(agent);
	await journal.write("audit_result", { output_chars: output.length, output });
	const parsed = parseFindings(output);
	await journal.write("findings_parsed", {
		count: parsed.findings.length, isSafe: parsed.isSafe, unparseable: parsed.unparseable,
	});
	emit({ type: "findings_parsed", count: parsed.findings.length, isSafe: parsed.isSafe });

	const report: LoopReport = {
		verifiedFindings: [],
		dropped: [],
		safeVerdict: parsed.isSafe,
		unparseable: parsed.unparseable,
		parsedCount: parsed.findings.length,
	};
	if (parsed.unparseable || parsed.isSafe || parsed.findings.length === 0) {
		await journal.write("report", { verified: 0, dropped: 0, safe: parsed.isSafe });
		return report;
	}

	// Repo rollouts verify agent-side through kernel fork.verify (harness-
	// executed ground truth). The deterministic phase would regenerate PoCs
	// against the inventory JSON and fail on missing repo files — wasting
	// teacher tokens and poisoning labels with false verification_failed.
	if (opts.deterministicVerify === false) {
		await journal.write("report", {
			verified: 0, dropped: 0, parsed: parsed.findings.length, agentVerified: true,
		});
		return report;
	}

	// --- verification phase (lazy anvil start: only when there is something to verify) ---
	const anvil = opts.anvil ?? (await startAnvil());
	const ordered = [...parsed.findings].sort(
		(a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity],
	);

	for (const finding of ordered) {
		emit({ type: "step", step: "verify", title: finding.title });
		let retryHint: string | undefined;
		let verdict: ForkVerdict | null = null;
		let pocCode = "";

		for (let attempt = 0; attempt <= maxRetries && !verdict?.verified; attempt++) {
			const pocResult = await pocTool.execute(`poc-${Date.now()}`, {
				finding_title: finding.title,
				finding_impact: finding.impact,
				contract_code: code,
				...(retryHint ? { retry_hint: retryHint } : {}),
			});
			pocCode = pocResult.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const extracted = (pocResult.details as { code?: string } | undefined)?.code;
			if (extracted) pocCode = extracted;
			await journal.write("poc_generated", {
				title: finding.title, attempt, poc_chars: pocCode.length, retryHint, code: pocCode,
			});

			verdict = await runPocOnAnvil(anvil, pocCode);
			await journal.write("fork_verdict", {
				title: finding.title, attempt, verified: verdict.verified, trace: verdict.trace,
			});
			retryHint = verdict.trace;
		}

		if (verdict?.verified) {
			report.verifiedFindings.push({ ...finding, verified: true, pocCode, verdict });
			await journal.write("finding_kept", { title: finding.title, severity: finding.severity });
		} else {
			report.dropped.push({ finding, reason: "verification_failed" });
			await journal.write("finding_dropped", {
				title: finding.title, reason: "verification_failed",
			});
		}
	}

	await journal.write("report", {
		verified: report.verifiedFindings.length, dropped: report.dropped.length,
		// Structured payloads only — never synthesized prose. The exporter
		// builds the final assistant message from the model's own words.
		verifiedFindings: report.verifiedFindings.map((f) => ({
			title: f.title, severity: f.severity, impact: f.impact, pocCode: f.pocCode,
		})),
	});
	emit({ type: "report", verified: report.verifiedFindings.length, dropped: report.dropped.length });
	return report;
}
