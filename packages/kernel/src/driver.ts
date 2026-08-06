/**
 * Executor drivers (spec §6, same pattern as the serving-manager).
 *
 * The driver decides WHERE and HOW the kernel runs. `local` first: a
 * per-session tmp dir with a private copy of the repo (originals never
 * touched), a scrubbed environment for the sidecar, and ulimits where
 * portable. `docker` is the future hard boundary — deferred until a
 * trigger fires.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKernel, type Kernel, type KernelOptions } from "./kernel.js";

export interface ExecSession {
	/** Session id — used in the tmp dir name and journal entries. */
	id: string;
	/** The mounted repo being audited (read-only source of truth). */
	repoRoot: string;
	/**
	 * Journal session dir for durable evidence (fork.verify raw logs are
	 * copied here as ATTIS_JOURNAL_DIR). Omit to keep scratch-only logs.
	 */
	journalDir?: string;
}

export interface ExecEnv {
	/** The live kernel running against the session's repo copy. */
	kernel: Kernel;
	/** Per-session scratch dir (sidecar cwd, PoC run dirs, raw logs). */
	scratchDir: string;
	/** Per-session copy of the repo the kernel mounts. */
	repoCopy: string;
	/** Stop the kernel and remove the session tmp dir. */
	cleanup(): Promise<void>;
}

export interface ExecutorDriver {
	prepare(session: ExecSession): Promise<ExecEnv>;
}

/** Exact names the sidecar may inherit (locale/terminal basics). */
const ENV_ALLOW_EXACT = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL",
	"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "TERM",
	"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
	// attis path config (not secrets): evidence dir + deps cache override.
	"ATTIS_JOURNAL_DIR", "ATTIS_DEPS_DIR",
]);

/**
 * Prefixes the sidecar may inherit: RPC access (the chain is the substrate)
 * and foundry config. Note the allowlist is deliberately NOT "ATTIS_*":
 * ATTIS_API_KEY (the serving key) must never reach executed code.
 */
const ENV_ALLOW_PREFIX = ["ATTIS_RPC", "ETH_RPC", "RPC_URL", "FOUNDRY_"];

/**
 * Scrub the environment for executed code: no AWS_/GH_/HF_/OPENAI_/
 * ANTHROPIC_/DEEPSEEK_ keys, no *_TOKEN/*_SECRET — only the allowlist
 * above survives. This is a hygiene layer, not a security boundary (the
 * docker driver is the boundary, spec §11).
 */
export function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (ENV_ALLOW_EXACT.has(key) || ENV_ALLOW_PREFIX.some((p) => key.startsWith(p))) {
			out[key] = value;
		}
	}
	return out;
}

/**
 * ulimit wrapper for the sidecar, where portable (POSIX only): cap user
 * processes against fork bombs. File-size/address-space limits are left
 * alone — python and forge need generous headroom. 4096 (not 512): the cap
 * must clear the host's own process count — 512 broke sidecar boot on any
 * machine already running >~500 user processes (suite-parallel flake).
 */
export function ulimitPrefix(): string[] {
	if (process.platform === "win32") return [];
	return ["/bin/sh", "-c", 'ulimit -u 4096 2>/dev/null || true; exec "$@"', "sh"];
}

export interface LocalDriverOptions {
	timeoutMs?: number;
	pythonPath?: string;
	helpersDir?: string;
	onRestart?: KernelOptions["onRestart"];
}

export class LocalDriver implements ExecutorDriver {
	constructor(private readonly opts: LocalDriverOptions = {}) {}

	async prepare(session: ExecSession): Promise<ExecEnv> {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `attis-${session.id}-`));
		const repoCopy = path.join(tmp, "repo");
		const scratchDir = path.join(tmp, "scratch");
		// Copy-on-prepare: executed code reads/writes the copy only.
		await fs.cp(session.repoRoot, repoCopy, { recursive: true });
		await fs.mkdir(scratchDir, { recursive: true });

		try {
			const kernel = await createKernel({
				repoRoot: repoCopy,
				scratchDir,
				helpersDir: this.opts.helpersDir,
				timeoutMs: this.opts.timeoutMs,
				pythonPath: this.opts.pythonPath,
				env: scrubEnv(process.env),
				// Durable evidence dir — survives the session tmp cleanup.
				...(session.journalDir ? { journalDir: session.journalDir } : {}),
				execPrefix: ulimitPrefix(),
				onRestart: this.opts.onRestart,
			});
			return {
				kernel,
				scratchDir,
				repoCopy,
				cleanup: async () => {
					await kernel.stop();
					await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
				},
			};
		} catch (err) {
			await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
	}
}

export class NotImplementedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotImplementedError";
	}
}

/**
 * Docker driver — interface-compliant stub. Deferred per spec §6/§11 until
 * one of the triggers fires; the local driver's env scrub + repo copy +
 * timeouts are explicitly NOT a hard sandbox.
 */
export class DockerDriver implements ExecutorDriver {
	async prepare(_session: ExecSession): Promise<ExecEnv> {
		throw new NotImplementedError(
			"docker executor driver deferred until a trigger fires (spec §6): " +
				"rollout fleet scale, untrusted third-party code, or hermetic eval " +
				"reproducibility. Use LocalDriver meanwhile.",
		);
	}
}
