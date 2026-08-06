/**
 * Process runners — the one seam between the drivers and the OS.
 *
 * Everything a driver needs from child_process goes through these two
 * types so tests can inject fakes (no real runpodctl/ssh/vllm in vitest).
 * The defaults are thin wrappers over node:child_process.
 */
import { execFile, spawn } from "node:child_process";

export interface CommandResult {
	stdout: string;
	stderr: string;
}

/** Run a command to completion and collect its output (execFile shape). */
export type ExecRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface SpawnOptions {
	detached?: boolean;
	/** Defaults to "ignore" — subprocesses of a CLI should never inherit stdio. */
	stdio?: "ignore" | "inherit";
	env?: Record<string, string | undefined>;
}

/**
 * A long-lived child (vllm server, ssh tunnel, watchdog). Intentionally
 * minimal: drivers need to signal it, await its exit once, and observe
 * whether it died on its own.
 */
export interface ManagedChild {
	readonly pid: number | undefined;
	/** exit code once the child has exited, null while it runs. */
	readonly exitCode: number | null;
	kill(signal?: string): boolean;
	onceExit(listener: (code: number | null, signal: string | null) => void): void;
	unref(): void;
}

export type SpawnRunner = (
	command: string,
	args: readonly string[],
	opts?: SpawnOptions,
) => ManagedChild;

export class CommandError extends Error {
	constructor(
		command: string,
		args: readonly string[],
		readonly exitCode: number | null,
		readonly stderr: string,
	) {
		super(
			`\`${command} ${args.join(" ")}\` failed (exit ${exitCode ?? "?"})` +
				(stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join("\n")}` : ""),
		);
	}
}

export const defaultExec: ExecRunner = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, [...args], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				const code = typeof err.code === "number" ? err.code : null;
				reject(new CommandError(command, args, code, stderr));
				return;
			}
			resolve({ stdout, stderr });
		});
	});

export const defaultSpawn: SpawnRunner = (command, args, opts = {}) => {
	const child = spawn(command, [...args], {
		detached: opts.detached ?? false,
		stdio: opts.stdio ?? "ignore",
		env: opts.env ? { ...process.env, ...opts.env } : undefined,
	});
	return {
		get pid() {
			return child.pid;
		},
		get exitCode() {
			return child.exitCode;
		},
		kill: (signal = "SIGTERM") => child.kill(signal as NodeJS.Signals),
		onceExit: (listener) => {
			child.once("exit", listener);
		},
		unref: () => child.unref(),
	};
};

/** SIGTERM, then SIGKILL after graceMs if the child is still running. */
export function terminateChild(child: ManagedChild, graceMs: number): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) return resolve();
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		};
		child.onceExit(done);
		// The timer is armed before SIGTERM: a child may exit synchronously
		// inside kill(), and done() must be able to clear it.
		const timer = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			done();
		}, graceMs);
		child.kill("SIGTERM");
	});
}
