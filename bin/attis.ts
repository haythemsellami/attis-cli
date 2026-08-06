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
 *   attis rollout <repos-root> [--teacher deepseek] [--force] [--max-repos N]
 *
 * Env:
 *   ATTIS_BASE_URL   OpenAI-compatible endpoint (default http://localhost:8000/v1)
 *   ATTIS_API_KEY    endpoint key (dummy ok for local vLLM)
 *   ATTIS_MODEL      model id at the endpoint (default "orgia")
 *   ATTIS_ALLOW_FORK set to 1 to allow fork_verify execution (else gated)
 *   DEEPSEEK_BASE_URL / DEEPSEEK_MODEL / DEEPSEEK_API_KEY  (--teacher deepseek)
 */
import { readFileSync } from "node:fs";
import { createAuditAgent, createGeneratePocTool, runAuditLoop, runRollout, parseRolloutArgs, ROLLOUT_USAGE, type RolloutCliArgs } from "../packages/core/src/index.js";
import { Journal } from "../packages/journal/src/index.js";
import { createServingManager, type DriverName } from "../packages/serving/src/index.js";

/** Extract --serving NAME from argv (returns argv with the flag removed). */
function extractServingFlag(argv: string[]): { serving: DriverName; rest: string[] } {
	const rest = [...argv];
	let serving: DriverName = "env";
	const i = rest.indexOf("--serving");
	if (i !== -1) {
		const name = rest[i + 1] ?? "";
		if (name !== "env" && name !== "local" && name !== "runpod") {
			throw new Error(`--serving must be env|local|runpod (got "${name}")`);
		}
		serving = name;
		rest.splice(i, 2);
	}
	return { serving, rest };
}

/**
 * Run fn against a serving-driver endpoint. The manager guarantees stop()
 * (and for runpod, pod stop — via the watchdog even on kill -9). "env"
 * changes nothing: the existing env-var endpoint rules apply.
 */
async function withServing<T>(name: DriverName, fn: () => Promise<T>): Promise<T> {
	if (name === "env") return fn();
	process.stderr.write(`attis: starting serving driver "${name}"…\n`);
	const manager = createServingManager();
	try {
		return await manager.withEndpoint(name, async (endpoint) => {
			const prev = { base: process.env.ATTIS_BASE_URL, model: process.env.ATTIS_MODEL };
			process.env.ATTIS_BASE_URL = endpoint.baseUrl;
			process.env.ATTIS_MODEL = endpoint.model;
			try {
				return await fn();
			} finally {
				if (prev.base === undefined) delete process.env.ATTIS_BASE_URL;
				else process.env.ATTIS_BASE_URL = prev.base;
				if (prev.model === undefined) delete process.env.ATTIS_MODEL;
				else process.env.ATTIS_MODEL = prev.model;
			}
		});
	} finally {
		process.stderr.write(`attis: serving driver "${name}" stopped\n`);
	}
}

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
  attis audit <file.sol> [--verify] [--output stream-json|text] [--serving env|local|runpod]
  attis rollout <repos-root> [--teacher deepseek] [--force] [--output stream-json|text] [--max-repos N] [--manifest path] [--serving env|local|runpod]
  attis inspect <events.jsonl>

  --verify   run the full loop: audit → parse → per-finding PoC →
             fork-verify (anvil+forge) → verified-only report
  --serving  serving driver for the model endpoint (default env). local
             spawns vllm; runpod starts the pod + tunnel and ALWAYS stops
             it on exit (watchdog covers kill -9)
  rollout    batch mode: audit every repo under <repos-root> (or a single
             repo dir) with the kernel enabled; resumable via the manifest
  inspect    replay a session journal (NDJSON, in order)
`;

function repoProgressLine(event: Record<string, unknown>): string | null {
	const repo = String(event.repo ?? "");
	switch (event.type) {
		case "repo_start":
			return `[${event.index}/${event.total}] ${repo} — auditing…`;
		case "repo_done":
			return `[${event.index}/${event.total}] ${repo} — done (${event.verified} verified)`;
		case "repo_failed":
			return `[${event.index}/${event.total}] ${repo} — FAILED: ${event.error}`;
		case "repo_skipped":
			return `[${event.index}/${event.total}] ${repo} — skipped (already done)`;
		default:
			return null;
	}
}

/** `attis rollout` — batch driver (roadmap v2 item 3). Returns the exit code. */
async function runRolloutCommand(argv: string[]): Promise<number> {
	let args: RolloutCliArgs;
	try {
		args = parseRolloutArgs(argv);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${ROLLOUT_USAGE}\n`);
		return 1;
	}
	const emit = (event: Record<string, unknown>) => {
		if (args.output === "stream-json") {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		} else {
			const line = repoProgressLine(event);
			if (line) process.stdout.write(`${line}\n`);
		}
	};
	const summary = await runRollout({ ...args, onEvent: emit });
	if (args.output === "text") {
		process.stdout.write(
			`rollout complete: ${summary.done} done, ${summary.failed} failed, ` +
				`${summary.skipped} skipped of ${summary.total} (manifest: ${summary.manifestPath})\n`,
		);
	}
	// 0 when ≥1 repo is done (this run or a previous one), 1 when all failed.
	return summary.done + summary.skipped >= 1 || summary.failed === 0 ? 0 : 1;
}

async function main(): Promise<void> {
	const { serving, rest: argv } = extractServingFlag(process.argv.slice(2));
	if (argv[0] === "rollout") {
		process.exit(await withServing(serving, () => runRolloutCommand(argv.slice(1))));
	}
	if (serving !== "env") {
		// audit path: wrap the whole command body in the serving scope
		await withServing(serving, () => runAuditCommand(argv));
		return;
	}
	await runAuditCommand(argv);
}

async function runAuditCommand(argv: string[]): Promise<void> {
	const opts = parseArgs(argv);
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
