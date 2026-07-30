#!/usr/bin/env tsx
/**
 * attis — the harness that drives Orgia.
 *
 * Spike CLI (milestone 1): headless audit of a single contract file with
 * events-first output. The TUI lands later; per the spec, no interaction
 * will exist in the TUI that is not available over this wire.
 *
 * Usage:
 *   attis audit <file.sol> [--output stream-json|text]
 *
 * Env:
 *   ATTIS_BASE_URL   OpenAI-compatible endpoint (default http://localhost:8000/v1)
 *   ATTIS_API_KEY    endpoint key (dummy ok for local vLLM)
 *   ATTIS_MODEL      model id at the endpoint (default "orgia")
 *   ATTIS_ALLOW_FORK set to 1 to allow fork_verify execution (else gated)
 */
import { readFileSync } from "node:fs";
import { createAuditAgent, createGeneratePocTool, runAuditLoop } from "../packages/core/src/index.js";
import { Journal } from "../packages/journal/src/index.js";

interface CliOptions {
	command: string;
	file?: string;
	output: "stream-json" | "text";
	verify: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const [command, ...rest] = argv;
	const opts: CliOptions = { command: command ?? "", output: "text", verify: false };
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--output") {
			opts.output = (rest[++i] ?? "text") as CliOptions["output"];
		} else if (rest[i] === "--verify") {
			opts.verify = true;
		} else if (!rest[i].startsWith("--") && !opts.file) {
			opts.file = rest[i];
		}
	}
	return opts;
}

const USAGE = `attis — the harness that drives Orgia

Usage:
  attis audit <file.sol> [--verify] [--output stream-json|text]
  attis inspect <events.jsonl>

  --verify   run the full loop: audit → parse → per-finding PoC →
             fork-verify (anvil+forge) → verified-only report
  inspect    replay a session journal (NDJSON, in order)
`;

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.command === "inspect" && opts.file) {
		// Minimal journal replay (roadmap item 5 acceptance): print the
		// session's events in order as NDJSON.
		const lines = readFileSync(opts.file, "utf-8").split("\n").filter(Boolean);
		for (const line of lines) process.stdout.write(`${line}\n`);
		return;
	}
	if (opts.command !== "audit" || !opts.file) {
		process.stderr.write(USAGE);
		process.exit(opts.command ? 1 : 0);
	}
	if (opts.output !== "stream-json" && opts.output !== "text") {
		process.stderr.write(`unknown --output mode: ${opts.output}\n${USAGE}`);
		process.exit(1);
	}

	const code = readFileSync(opts.file, "utf-8");
	const emit = (event: Record<string, unknown>) => {
		if (opts.output === "stream-json") process.stdout.write(`${JSON.stringify(event)}\n`);
	};

	if (opts.verify) {
		const journal = await Journal.open(opts.file);
		const agent = createAuditAgent({
			onEvent: (event) => {
				emit(event as unknown as Record<string, unknown>);
			},
		});
		const pocTool = createGeneratePocTool({
			baseUrl: process.env.ATTIS_BASE_URL ?? "http://localhost:8000/v1",
			apiKey: process.env.ATTIS_API_KEY ?? "EMPTY",
			model: process.env.ATTIS_MODEL ?? "orgia",
		});
		try {
			const report = await runAuditLoop(code, {
				agent,
				pocTool,
				journal,
				onEvent: emit,
			});
			emit({
				type: "final_report",
				verifiedFindings: report.verifiedFindings.map((f) => ({
					severity: f.severity, title: f.title, impact: f.impact,
				})),
				dropped: report.dropped.map((d) => ({ title: d.finding.title, reason: d.reason })),
				safeVerdict: report.safeVerdict,
				unparseable: report.unparseable,
				journal: journal.session.eventsPath,
			});
			await journal.close({ verified: report.verifiedFindings.length });
		} catch (err) {
			await journal.close({ error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
		return;
	}

	const agent = createAuditAgent({
		onEvent: (event) => {
			if (opts.output === "stream-json") {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else if (event.type === "message_update") {
				const streamEvent = (event as { assistantMessageEvent?: { type: string; delta?: string } })
					.assistantMessageEvent;
				if (streamEvent?.type === "text_delta" && streamEvent.delta) {
					process.stdout.write(streamEvent.delta);
				}
			}
		},
	});

	await agent.prompt(`Audit this contract:\n\n\`\`\`solidity\n${code}\n\`\`\``);
	await agent.waitForIdle();
	if (opts.output === "text") process.stdout.write("\n");
}

main().catch((err) => {
	process.stderr.write(`attis: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
