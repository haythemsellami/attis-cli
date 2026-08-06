/**
 * kernel — TS manager for the persistent Python sidecar (spec §6).
 *
 * One sidecar process per audit session; a JSON-lines request/response
 * protocol over stdio with id matching, a per-call hard timeout (the
 * sidecar's own signal.alarm fires first and answers cleanly), crash
 * detection, and one automatic restart with a fresh namespace per crash
 * (flagged in the result so callers can journal it).
 *
 * Executions are serialized: the sidecar has one namespace and one
 * process-wide alarm, so concurrent cells would race.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

export interface KernelOptions {
	/** Mounted repo root the repo helper confines reads to (the session copy). */
	repoRoot: string;
	/** Session scratch dir — the sidecar chdirs here at boot. */
	scratchDir: string;
	/** Helper library dir; defaults to the helpers_py/ next to this file. */
	helpersDir?: string;
	/** Default per-call timeout (hard kill at timeoutMs + grace). Default 120s. */
	timeoutMs?: number;
	pythonPath?: string;
	/**
	 * Environment for the sidecar. Default: process.env as-is — production
	 * callers should go through LocalDriver, which passes a scrubbed env.
	 */
	env?: NodeJS.ProcessEnv;
	/** argv prepended before python (LocalDriver's ulimit wrapper). */
	execPrefix?: string[];
	/** Called after every automatic restart (journal hook). */
	onRestart?: (info: { reason: string; restartCount: number }) => void | Promise<void>;
}

export interface ExecOptions {
	timeoutMs?: number;
}

export interface ExecErrorInfo {
	type: string;
	message: string;
	traceback: string;
}

export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** repr() of the cell's last expression, or null. */
	result: string | null;
	error: ExecErrorInfo | null;
	/** True when this call ran against a freshly restarted namespace. */
	restarted: boolean;
	durationMs: number;
}

export interface Kernel {
	exec(code: string, opts?: ExecOptions): Promise<ExecResult>;
	stop(): Promise<void>;
	readonly pid: number | null;
	readonly restartCount: number;
}

interface SidecarResponse {
	id: number | null;
	ok: boolean;
	boot?: boolean;
	stdout?: string;
	stderr?: string;
	result?: string | null;
	error?: ExecErrorInfo | null;
}

interface Pending {
	resolve: (r: SidecarResponse) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

class KernelCrashError extends Error {
	constructor() {
		super("kernel sidecar crashed (namespace lost; next exec restarts fresh)");
		this.name = "KernelCrashError";
	}
}

/** Extra time the TS side waits past the sidecar's own alarm before killing. */
const HARD_GRACE_MS = 10_000;
const BOOT_TIMEOUT_MS = 15_000;

const SIDECAR_PATH = fileURLToPath(new URL("./sidecar.py", import.meta.url));
const DEFAULT_HELPERS_DIR = fileURLToPath(new URL("./helpers_py/", import.meta.url));

class SidecarKernel implements Kernel {
	private child: ChildProcess | null = null;
	private rl: readline.Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private tail: Promise<unknown> = Promise.resolve();
	private stopped = false;
	private restarts = 0;

	constructor(private readonly opts: Required<Pick<KernelOptions, "repoRoot" | "scratchDir" | "helpersDir" | "timeoutMs" | "pythonPath">> & KernelOptions) {}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	get restartCount(): number {
		return this.restarts;
	}

	async boot(): Promise<void> {
		await this.spawnAndWait();
	}

	/** Serialize cells: one namespace, one alarm — no concurrent execs. */
	exec(code: string, opts: ExecOptions = {}): Promise<ExecResult> {
		const run = this.tail.then(() => this.execNow(code, opts));
		this.tail = run.catch(() => {});
		return run;
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error("kernel stopped"));
		}
		this.pending.clear();
		const child = this.child;
		this.child = null;
		this.rl?.close();
		if (!child || child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
				resolve();
			}, 2000);
		});
	}

	private spawnAndWait(): Promise<void> {
		const args = [
			...(this.opts.execPrefix ?? []),
			this.opts.pythonPath,
			SIDECAR_PATH,
			this.opts.scratchDir,
			this.opts.repoRoot,
			this.opts.helpersDir,
		];
		const child = spawn(args[0], args.slice(1), {
			env: this.opts.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.rl = readline.createInterface({ input: child.stdout! });
		this.rl.on("line", (line) => this.onLine(line));
		child.on("exit", () => this.onExit());

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`sidecar did not boot within ${BOOT_TIMEOUT_MS}ms`));
			}, BOOT_TIMEOUT_MS);
			const rl = this.rl!;
			const onBootLine = (line: string) => {
				let msg: SidecarResponse;
				try {
					msg = JSON.parse(line) as SidecarResponse;
				} catch {
					return;
				}
				if (msg.boot) {
					clearTimeout(timer);
					rl.off("line", onBootLine);
					child.off("exit", onEarlyExit);
					child.off("error", onSpawnError);
					resolve();
				}
			};
			const onEarlyExit = () => {
				clearTimeout(timer);
				reject(new Error("sidecar exited during boot — check pythonPath and helpers"));
			};
			const onSpawnError = (err: Error) => {
				clearTimeout(timer);
				reject(new Error(`failed to spawn sidecar (${this.opts.pythonPath}): ${err.message}`));
			};
			rl.on("line", onBootLine);
			child.once("exit", onEarlyExit);
			child.once("error", onSpawnError);
		});
	}

	private onLine(line: string): void {
		let msg: SidecarResponse;
		try {
			msg = JSON.parse(line) as SidecarResponse;
		} catch {
			return; // non-protocol noise on stdout — drop it
		}
		if (msg.id === null) return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		p.resolve(msg);
	}

	private onExit(): void {
		this.child = null;
		this.rl?.close();
		this.rl = null;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new KernelCrashError());
		}
		this.pending.clear();
	}

	private async execNow(code: string, opts: ExecOptions): Promise<ExecResult> {
		if (this.stopped) throw new Error("kernel is stopped");
		const started = Date.now();
		let restarted = false;
		if (!this.child) {
			await this.restart("sidecar died");
			restarted = true;
		}
		const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
		const id = this.nextId++;
		// The sidecar's alarm answers first; the hard deadline only fires when
		// user code is stuck somewhere alarm can't reach (blocking C call).
		const alarmSeconds = Math.max(1, Math.floor(timeoutMs / 1000));
		const request = JSON.stringify({ id, code, timeout: alarmSeconds });

		try {
			const msg = await new Promise<SidecarResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					this.killChild();
					resolve({
						id, ok: false, stdout: "", stderr: "", result: null,
						error: {
							type: "TimeoutError",
							message: `hard timeout: sidecar unresponsive ${timeoutMs}ms + ${HARD_GRACE_MS}ms grace; process killed`,
							traceback: "",
						},
					});
				}, timeoutMs + HARD_GRACE_MS);
				this.pending.set(id, { resolve, reject, timer });
				try {
					this.child!.stdin!.write(request + "\n");
				} catch {
					// Process died between the alive-check and the write.
					this.pending.delete(id);
					clearTimeout(timer);
					reject(new KernelCrashError());
				}
			});
			return {
				ok: msg.ok,
				stdout: msg.stdout ?? "",
				stderr: msg.stderr ?? "",
				result: msg.result ?? null,
				error: msg.error ?? null,
				restarted,
				durationMs: Date.now() - started,
			};
		} catch (err) {
			if (err instanceof KernelCrashError) {
				return {
					ok: false, stdout: "", stderr: "", result: null,
					error: { type: "KernelCrash", message: err.message, traceback: "" },
					restarted, durationMs: Date.now() - started,
				};
			}
			throw err;
		}
	}

	private killChild(): void {
		const child = this.child;
		this.child = null;
		this.rl?.close();
		this.rl = null;
		if (child && child.exitCode === null) child.kill("SIGKILL");
	}

	private async restart(reason: string): Promise<void> {
		this.killChild();
		this.restarts += 1;
		await this.opts.onRestart?.({ reason, restartCount: this.restarts });
		await this.spawnAndWait();
	}
}

export async function createKernel(opts: KernelOptions): Promise<Kernel> {
	if (!opts.repoRoot) throw new Error("KernelOptions.repoRoot is required");
	if (!opts.scratchDir) throw new Error("KernelOptions.scratchDir is required");
	const kernel = new SidecarKernel({
		...opts,
		repoRoot: opts.repoRoot,
		scratchDir: opts.scratchDir,
		helpersDir: opts.helpersDir ?? DEFAULT_HELPERS_DIR,
		timeoutMs: opts.timeoutMs ?? 120_000,
		pythonPath: opts.pythonPath ?? "python3",
	});
	await kernel.boot();
	return kernel;
}
