/**
 * Rollout mode (roadmap v2 item 3) — the batch driver over repos.
 *
 * For each repo under a root (or a single repo dir): LocalDriver.prepare →
 * kernel up → audit agent with the execute_code tool + the repo.tree()
 * inventory injected into the audit prompt → the v1 audit loop → cleanup.
 * Sequential per repo, teacher-configurable (bootstrap rollouts are driven
 * by the base 9B endpoint or deepseek-v4-pro, never the v7.x adapters),
 * journal-first (one Journal per repo session — the item-5 exporter
 * consumes exactly these existing event shapes), and resumable via a
 * manifest recording per-repo status.
 *
 * Failure containment: one repo's failure (kernel crash, endpoint down,
 * fork layer death) marks that repo failed with the error journaled and
 * the rollout continues with the next repo.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import {
	LocalDriver,
	loadPolicy,
	type ExecEnv,
	type ExecutorDriver,
	type Kernel,
	type Policy,
} from "@attis/kernel";
import { Journal } from "@attis/journal";
import type { ServingConfig } from "@attis/serving";
import { createAuditAgent } from "./agent.js";
import { parseFindings } from "./findings.js";
import { runAuditLoop, assistantText, type LoopReport } from "./loop.js";
import { createExecuteCodeTool } from "./tools/execute-code.js";
import { createGeneratePocTool } from "./tools/generate-poc.js";

// ---------------------------------------------------------------------------
// Teacher configuration (spec §6: bootstrap rollouts are teacher-driven).
// Only env var NAMES ever leave this module — never their values.
// ---------------------------------------------------------------------------

export type TeacherName = "default" | "deepseek";
export type EnvMap = Record<string, string | undefined>;

/**
 * Resolve the serving config for a teacher. "default" is the serving-manager
 * env-driver contract (ATTIS_VLLM_BASE_URL ?? ATTIS_BASE_URL, ATTIS_MODEL —
 * the base Qwen3.5-9B on the pod is just this default endpoint case);
 * "deepseek" switches to the DEEPSEEK_* env triple.
 */
export function teacherServingConfig(
	teacher: TeacherName = "default",
	env: EnvMap = process.env,
): ServingConfig {
	const shared = {
		contextWindow: Number(env.ATTIS_CONTEXT_WINDOW ?? 131072),
		maxTokens: Number(env.ATTIS_MAX_TOKENS ?? 32768),
	};
	if (teacher === "deepseek") {
		return {
			baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
			apiKeyEnv: ["DEEPSEEK_API_KEY"],
			modelId: env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
			providerId: "deepseek",
			...shared,
		};
	}
	return {
		baseUrl: env.ATTIS_VLLM_BASE_URL ?? env.ATTIS_BASE_URL ?? "http://localhost:8000/v1",
		apiKeyEnv: ["ATTIS_API_KEY"],
		modelId: env.ATTIS_MODEL ?? "orgia",
		providerId: "attis-local",
		...shared,
	};
}

function firstEnvValue(names: readonly string[], env: EnvMap): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value) return value;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Repo discovery: a directory of repos (each subdir = one audit target) or a
// single repo dir.
// ---------------------------------------------------------------------------

/** Marker files that identify a directory as a repo in its own right. */
const REPO_MARKERS = [
	"foundry.toml",
	"hardhat.config.ts",
	"hardhat.config.js",
	"hardhat.config.cjs",
	"brownie-config.yaml",
	"truffle-config.js",
	".git",
];

/** Same skip set as the kernel's repo helper (no audit signal). */
const SKIP_DIRS = new Set([".git", "node_modules", "out", "cache", "broadcast", "lib", "artifacts"]);

async function containsSol(dir: string): Promise<boolean> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
			if (await containsSol(path.join(dir, entry.name))) return true;
		} else if (entry.name.endsWith(".sol")) {
			return true;
		}
	}
	return false;
}

/** A dir is itself a repo when it has a marker file or top-level .sol. */
async function isRepoDir(dir: string): Promise<boolean> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (REPO_MARKERS.includes(entry.name)) return true;
		if (!entry.isDirectory() && entry.name.endsWith(".sol")) return true;
	}
	return false;
}

/**
 * Discover audit targets: the root itself when it looks like a repo (marker
 * file or top-level .sol), else every immediate subdirectory containing
 * Solidity. Throws when there is nothing to audit.
 */
export async function discoverRepos(rootDir: string): Promise<string[]> {
	const root = path.resolve(rootDir);
	const stat = await fs.stat(root).catch(() => null);
	if (!stat?.isDirectory()) {
		throw new Error(`rollout target is not a directory: ${rootDir}`);
	}
	if (await isRepoDir(root)) return [root];
	const subdirs = (await fs.readdir(root, { withFileTypes: true }))
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.map((e) => path.join(root, e.name))
		.sort();
	const repos: string[] = [];
	for (const sub of subdirs) {
		if (await containsSol(sub)) repos.push(sub);
	}
	// Bare repo without markers: .sol only reachable through nested dirs.
	if (repos.length === 0 && (await containsSol(root))) return [root];
	if (repos.length === 0) {
		throw new Error(`no Solidity repos found under ${rootDir}`);
	}
	return repos;
}

// ---------------------------------------------------------------------------
// Manifest (resumability): <repos-root>/.attis-rollout.json or --manifest.
// ---------------------------------------------------------------------------

export type RepoStatus = "pending" | "running" | "done" | "failed";

export interface ManifestRepo {
	status: RepoStatus;
	/** Journal session id of the (last) run. */
	sessionId?: string;
	/** Deterministically verified findings (v1 single-contract path; 0 in repo mode). */
	verified?: number;
	/** Findings parsed from the agent's audit (repo mode metric; agent verifies via kernel fork.verify). */
	findings?: number;
	/** Failure message when status is "failed". */
	error?: string;
}

export interface RolloutManifest {
	version: 1;
	repos: Record<string, ManifestRepo>;
}

export async function loadManifest(manifestPath: string): Promise<RolloutManifest> {
	const raw = await fs.readFile(manifestPath, "utf-8").catch(() => null);
	if (raw === null) return { version: 1, repos: {} };
	try {
		const data = JSON.parse(raw) as RolloutManifest;
		if (data.version !== 1 || typeof data.repos !== "object" || data.repos === null) {
			throw new Error("unexpected shape");
		}
		return data;
	} catch (err) {
		throw new Error(
			`rollout manifest at ${manifestPath} is corrupt: ${err instanceof Error ? err.message : String(err)}. ` +
				`Fix it by hand or delete it to start a fresh rollout.`,
		);
	}
}

async function saveManifest(manifestPath: string, manifest: RolloutManifest): Promise<void> {
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	// Write-then-rename: a crash mid-rollout must not corrupt the resume state.
	const tmp = `${manifestPath}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
	await fs.rename(tmp, manifestPath);
}

// ---------------------------------------------------------------------------
// Repo inventory (the kernel's repo.tree() helper: file list + import graph).
// ---------------------------------------------------------------------------

export interface RepoInventory {
	files: string[];
	imports: Record<string, string[]>;
}

const INVENTORY_CELL = "import json; print(json.dumps(repo.tree()))";

/**
 * Pull repo.tree() out of the kernel. Journaled as `repo_inventory` — harness
 * setup, NOT model behavior: the exporter folds it into row metadata, and the
 * inventory itself rides inside the audit prompt (buildRepoAuditPrompt).
 */
async function loadInventory(kernel: Kernel, journal: Journal): Promise<RepoInventory> {
	const r = await kernel.exec(INVENTORY_CELL);
	if (!r.ok) {
		await journal.write("repo_inventory", { ok: false, error: r.error, duration_ms: r.durationMs });
		throw new Error(`repo.tree() inventory failed: ${r.error?.message ?? "unknown kernel error"}`);
	}
	let inv: RepoInventory;
	try {
		inv = JSON.parse(r.stdout) as RepoInventory;
	} catch {
		throw new Error("repo.tree() returned an unparseable inventory");
	}
	if (!Array.isArray(inv.files) || typeof inv.imports !== "object" || inv.imports === null) {
		throw new Error("repo.tree() returned an unparseable inventory");
	}
	await journal.write("repo_inventory", {
		ok: true, files: inv.files, imports: inv.imports, duration_ms: r.durationMs,
	});
	return inv;
}

/**
 * Kernel-mode auditor prompt (spec §6 constraint descriptions). The findings
 * format section is verbatim from AUDITOR_SYSTEM_PROMPT — parseFindings and
 * the flywheel depend on it.
 */
export const ROLLOUT_SYSTEM_PROMPT = `You are Orgia, an expert EVM smart-contract security auditor.

A Solidity repo is mounted in your persistent audit kernel. Explore it with the execute_code tool: repo.tree() (file list + import graph), repo.read(path), slither.scan(path?), and the fork helpers (fork.create/fork.verify/fork.snapshot/fork.revert) for on-chain verification. Variables and imports survive across execute_code calls.

Analyze the code carefully: trace value flow across contracts, check access control, review external calls, and simulate adversarial interactions. Verify every candidate finding with a fork PoC (fork.verify) before reporting it.

fork.verify handles dependencies automatically (forge-std/OpenZeppelin/solmate/solady, era-matched to the repo's pragmas, with one compile-fallback retry) and runs the PoC inside the repo's own foundry project when one exists. Write the PoC's pragma to match the repo era: for pre-0.8 repos use pragma solidity >=0.6.x plus pragma experimental ABIEncoderV2 (the abicoder v2 spelling is rejected by solc 0.6.x) — a ^0.8.x PoC cannot compile against a pre-0.8 contract.

For each finding, report:
- **Severity:** Critical, High, Medium, or Low
- **Location:** function name and file
- **Description:** the vulnerability, its root cause, and how an attacker would exploit it
- **Proof of Concept:** concrete exploitation steps or code

Format findings as:
### [Severity] Title
**Impact:** what an attacker gains and what the protocol loses
**Proof of Concept:** exploitation steps or code
**Remediation:** how to fix it

DO NOT: access the network outside the RPC proxy, use real private keys, or write outside the scratch dir — the execpolicy blocks these.

If the code is safe, state that clearly and explain the key safety properties you verified.`;

/** Deterministic follow-up when findings ship without any fork verification. */
export const VERIFICATION_ENFORCEMENT_PROMPT = (count: number) =>
	`You reported ${count} finding(s) but ran fork.verify for NONE of them. On-chain verification is mandatory, not optional. For each finding now: write a forge PoC and run fork.verify (deps are auto-provisioned and era-matched; match the PoC pragma to the repo era — pre-0.8 repos need pragma experimental ABIEncoderV2). If a finding genuinely cannot be expressed as a fork PoC, say so explicitly and mark it unverified. Then re-report all findings with their verification status.`;

/** fork.verify verdict markers journaled so far (reads the session events file). */
async function countForkVerdicts(eventsPath: string): Promise<number> {
	try {
		const raw = await fs.readFile(eventsPath, "utf-8");
		return raw.split("ATTIS_FORK_VERDICT").length - 1;
	} catch {
		return 0;
	}
}

/** The audit-phase user prompt: the repo inventory, injected per roadmap item 3. */
export function buildRepoAuditPrompt(inv: RepoInventory): string {
	const files = inv.files.map((f) => `  ${f}`).join("\n");
	const imports = Object.entries(inv.imports)
		.map(([file, deps]) => `  ${file} ← ${deps.join(", ")}`)
		.join("\n");
	return (
		`Audit this Solidity repo. It is mounted in your kernel — explore it with execute_code ` +
		`(repo.read, slither.scan, fork.verify), do not ask for source to be pasted.\n\n` +
		`Repo inventory from repo.tree() (${inv.files.length} files):\n${files || "  (empty)"}\n\n` +
		`Import graph:\n${imports || "  (none)"}\n\n` +
		`Start from the import-graph roots, read the contracts, trace cross-contract interactions, ` +
		`and verify every candidate finding on a fork before reporting it.`
	);
}

// ---------------------------------------------------------------------------
// The batch driver.
// ---------------------------------------------------------------------------

/** What the agent factory receives — tests stub the agent here (fake model). */
export interface RolloutAgentContext {
	serving: ServingConfig;
	tools: AgentTool<any>[];
	systemPrompt: string;
	onEvent?: (event: AgentEvent) => void;
}

export type RolloutAgentFactory = (ctx: RolloutAgentContext) => Agent;
export type RolloutPocToolFactory = (serving: ServingConfig) => AgentTool<any>;
export type JournalFactory = (repoPath: string) => Promise<Journal>;

export interface RolloutOptions {
	/** Directory of repos, or a single repo dir. */
	rootDir: string;
	teacher?: TeacherName;
	/** Re-run all repos, including ones the manifest marks done. */
	force?: boolean;
	/** Manifest path; default <rootDir>/.attis-rollout.json. */
	manifestPath?: string;
	/** Smoke runs: audit only the first N discovered repos. */
	maxRepos?: number;
	/** Environment for teacher config resolution (defaults to process.env). */
	env?: EnvMap;
	onEvent?: (event: Record<string, unknown>) => void;
	// --- DI seams (tests); production defaults hit the real stack. ---
	driver?: ExecutorDriver;
	policy?: Policy;
	createAgent?: RolloutAgentFactory;
	createPocTool?: RolloutPocToolFactory;
	journalFor?: JournalFactory;
}

export interface RolloutRepoResult {
	repo: string;
	status: "done" | "failed" | "skipped";
	verified?: number;
	findings?: number;
	sessionId?: string;
	error?: string;
}

export interface RolloutSummary {
	total: number;
	/** Completed in this run. */
	done: number;
	/** Failed in this run (the batch continued past each). */
	failed: number;
	/** Already done in the manifest — not re-run. */
	skipped: number;
	results: RolloutRepoResult[];
	manifestPath: string;
}

const DEFAULT_POLICY_PATH = fileURLToPath(
	new URL("../../../policy/execpolicy.json", import.meta.url),
);

interface RepoRunContext {
	repoPath: string;
	journal: Journal;
	driver: ExecutorDriver;
	policy: Policy;
	serving: ServingConfig;
	createAgent: RolloutAgentFactory;
	createPocTool: RolloutPocToolFactory;
	emit: (event: Record<string, unknown>) => void;
}

/** One repo: kernel up → inventory → audit loop → journal → cleanup. */
async function runRepoAudit(ctx: RepoRunContext): Promise<{ verified: number; findings: number }> {
	const { journal } = ctx;
	let env: ExecEnv | null = null;
	try {
		env = await ctx.driver.prepare({
			id: journal.session.id,
			repoRoot: ctx.repoPath,
			// fork.verify raw logs land here (ATTIS_JOURNAL_DIR) — durable
			// evidence past the session scratch cleanup.
			journalDir: journal.session.dir,
		});
		const inventory = await loadInventory(env.kernel, journal);
		const executeCode = createExecuteCodeTool({
			kernel: env.kernel,
			policy: ctx.policy,
			journal,
		});
		// The agent runtime swallows endpoint failures into error-stop events
		// instead of throwing; surface them so the repo is marked failed, not
		// done-with-an-empty-trace (which resume would never retry).
		let agentError: string | null = null;
		const agent = ctx.createAgent({
			serving: ctx.serving,
			tools: [executeCode],
			systemPrompt: ROLLOUT_SYSTEM_PROMPT,
			onEvent: (event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const msg = event.message;
					if (msg.stopReason === "error") {
						agentError = msg.errorMessage ?? "unknown model error";
					}
				}
				ctx.emit(event as unknown as Record<string, unknown>);
			},
		});
		const report: LoopReport = await runAuditLoop(JSON.stringify(inventory), {
			agent,
			pocTool: ctx.createPocTool(ctx.serving),
			journal,
			auditPrompt: buildRepoAuditPrompt(inventory),
			systemPrompt: ROLLOUT_SYSTEM_PROMPT,
			deterministicVerify: false, // agent verifies via kernel fork.verify
			onEvent: ctx.emit,
		});
		if (agentError) {
			throw new Error(`model endpoint error during audit: ${agentError}`);
		}

		// Verification enforcement (verify-don't-guess is harness-enforced, not
		// prompt-hoped): findings reported with zero fork.verify verdicts get
		// ONE deterministic re-prompt. Measured need: malt/velodrome sessions
		// reported 6/3 findings with zero verification attempts.
		let parsedCount = report.parsedCount;
		if (parsedCount > 0 && (await countForkVerdicts(journal.session.eventsPath)) === 0) {
			ctx.emit({ type: "step", step: "enforce-verify", count: parsedCount });
			await agent.prompt(VERIFICATION_ENFORCEMENT_PROMPT(parsedCount));
			await agent.waitForIdle();
			const followup = assistantText(agent);
			await journal.write("audit_result", {
				output_chars: followup.length, output: followup, enforcement: true,
			});
			const reparsed = parseFindings(followup);
			await journal.write("findings_parsed", {
				count: reparsed.findings.length, isSafe: reparsed.isSafe,
				unparseable: reparsed.unparseable, enforcement: true,
			});
			if (!reparsed.unparseable && reparsed.findings.length > 0) {
				parsedCount = reparsed.findings.length;
			}
		}

		await journal.close({ verified: report.verifiedFindings.length, findings: parsedCount });
		return { verified: report.verifiedFindings.length, findings: parsedCount };
	} catch (err) {
		// The error lands in the repo's own journal (session_end) and the
		// manifest — the batch then moves on to the next repo.
		await journal
			.close({ error: err instanceof Error ? err.message : String(err) })
			.catch(() => {});
		throw err;
	} finally {
		if (env) await env.cleanup().catch(() => {});
	}
}

/**
 * Run the rollout: sequential per repo, resumable via the manifest, one
 * repo's failure contained to that repo. Returns the batch summary; the CLI
 * maps it to an exit code (0 when ≥1 repo is done).
 */
export async function runRollout(opts: RolloutOptions): Promise<RolloutSummary> {
	const root = path.resolve(opts.rootDir);
	const envMap = opts.env ?? process.env;
	const teacher = opts.teacher ?? "default";
	const serving = teacherServingConfig(teacher, envMap);
	const policy = opts.policy ?? loadPolicy(DEFAULT_POLICY_PATH);
	const driver = opts.driver ?? new LocalDriver();
	const journalFor = opts.journalFor ?? ((repoPath: string) => Journal.open(repoPath));
	const createAgent =
		opts.createAgent ??
		((ctx: RolloutAgentContext) =>
			createAuditAgent({
				serving: ctx.serving,
				tools: ctx.tools,
				systemPrompt: ctx.systemPrompt,
				onEvent: ctx.onEvent,
			}));
	const createPocTool =
		opts.createPocTool ??
		((cfg: ServingConfig) =>
			createGeneratePocTool({
				baseUrl: cfg.baseUrl,
				// Keyless local servers still need a placeholder (pi-ai throws otherwise).
				apiKey: firstEnvValue(cfg.apiKeyEnv, envMap) ?? "EMPTY",
				model: cfg.modelId,
			}));
	const emit = (event: Record<string, unknown>) => opts.onEvent?.(event);

	let repos = await discoverRepos(root);
	if (opts.maxRepos !== undefined) repos = repos.slice(0, opts.maxRepos);
	const nameOf = (repoPath: string) => path.relative(root, repoPath) || path.basename(repoPath);
	const manifestPath = opts.manifestPath ?? path.join(root, ".attis-rollout.json");
	const manifest = await loadManifest(manifestPath);

	// Reconcile: new repos enter as pending, --force re-runs everything, and
	// repos interrupted mid-run (status "running") reset to pending.
	for (const repoPath of repos) {
		const name = nameOf(repoPath);
		const existing = manifest.repos[name];
		if (!existing || opts.force || existing.status === "running") {
			manifest.repos[name] = { status: "pending" };
		}
	}
	await saveManifest(manifestPath, manifest);

	emit({
		type: "rollout_start",
		total: repos.length,
		repos: repos.map(nameOf),
		teacher,
		model: serving.modelId,
		manifest: manifestPath,
	});

	const summary: RolloutSummary = {
		total: repos.length,
		done: 0,
		failed: 0,
		skipped: 0,
		results: [],
		manifestPath,
	};

	for (let i = 0; i < repos.length; i++) {
		const repoPath = repos[i];
		const name = nameOf(repoPath);
		const entry = manifest.repos[name];
		const progress = { repo: name, index: i + 1, total: repos.length };

		if (entry.status === "done") {
			summary.skipped += 1;
			summary.results.push({
				repo: name,
				status: "skipped",
				...(entry.verified !== undefined ? { verified: entry.verified } : {}),
				...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
			});
			emit({ type: "repo_skipped", ...progress });
			continue;
		}

		emit({ type: "repo_start", ...progress });
		entry.status = "running";
		entry.error = undefined;

		let journal: Journal;
		try {
			journal = await journalFor(repoPath);
		} catch (err) {
			entry.status = "failed";
			entry.error = err instanceof Error ? err.message : String(err);
			await saveManifest(manifestPath, manifest);
			summary.failed += 1;
			summary.results.push({ repo: name, status: "failed", error: entry.error });
			emit({ type: "repo_failed", ...progress, error: entry.error });
			continue;
		}
		entry.sessionId = journal.session.id;
		await saveManifest(manifestPath, manifest);

		const repoEmit = (event: Record<string, unknown>) => emit({ ...event, repo: name });
		try {
			const { verified, findings } = await runRepoAudit({
				repoPath,
				journal,
				driver,
				policy,
				serving,
				createAgent,
				createPocTool,
				emit: repoEmit,
			});
			entry.status = "done";
			entry.verified = verified;
			entry.findings = findings;
			summary.done += 1;
			summary.results.push({
				repo: name,
				status: "done",
				verified,
				findings,
				sessionId: journal.session.id,
			});
			emit({ type: "repo_done", ...progress, verified, findings, sessionId: journal.session.id });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			entry.status = "failed";
			entry.error = message;
			summary.failed += 1;
			summary.results.push({
				repo: name,
				status: "failed",
				sessionId: journal.session.id,
				error: message,
			});
			emit({ type: "repo_failed", ...progress, error: message });
		}
		await saveManifest(manifestPath, manifest);
	}

	emit({
		type: "rollout_done",
		done: summary.done,
		failed: summary.failed,
		skipped: summary.skipped,
		total: summary.total,
	});
	return summary;
}

// ---------------------------------------------------------------------------
// CLI argument parsing (bin/attis.ts wires this into `attis rollout`).
// ---------------------------------------------------------------------------

export interface RolloutCliArgs {
	rootDir: string;
	teacher: TeacherName;
	force: boolean;
	output: "stream-json" | "text";
	maxRepos?: number;
	manifestPath?: string;
}

export const ROLLOUT_USAGE =
	"attis rollout <repos-root> [--teacher deepseek] [--force] [--output stream-json|text] [--max-repos N] [--manifest path]";

export function parseRolloutArgs(argv: string[]): RolloutCliArgs {
	const out: RolloutCliArgs = { rootDir: "", teacher: "default", force: false, output: "text" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		// pnpm swallows the first `--` separator poorly; tolerate a bare one.
		if (arg === "--") continue;
		if (arg === "--teacher") {
			const value = argv[++i];
			if (value !== "default" && value !== "deepseek") {
				throw new Error(`unknown --teacher: ${value ?? "(missing)"} (expected "default" or "deepseek")`);
			}
			out.teacher = value;
		} else if (arg === "--force") {
			out.force = true;
		} else if (arg === "--output") {
			const value = argv[++i];
			if (value !== "stream-json" && value !== "text") {
				throw new Error(`unknown --output mode: ${value ?? "(missing)"}`);
			}
			out.output = value;
		} else if (arg === "--max-repos") {
			const raw = argv[++i];
			const value = Number(raw);
			if (!Number.isInteger(value) || value < 1) {
				throw new Error(`--max-repos must be a positive integer, got "${raw ?? "(missing)"}"`);
			}
			out.maxRepos = value;
		} else if (arg === "--manifest") {
			const value = argv[++i];
			if (!value) throw new Error("--manifest requires a path");
			out.manifestPath = value;
		} else if (arg.startsWith("--")) {
			throw new Error(`unknown flag: ${arg}`);
		} else if (!out.rootDir) {
			out.rootDir = arg;
		} else {
			throw new Error(`unexpected argument: ${arg}`);
		}
	}
	if (!out.rootDir) {
		throw new Error(`missing repos root.\nUsage: ${ROLLOUT_USAGE}`);
	}
	return out;
}
