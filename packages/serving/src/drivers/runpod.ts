/**
 * runpod driver — pod lifecycle + SSH tunnel + guaranteed stop.
 *
 * The golden rule by construction: a running pod bills per second, so every
 * exit path stops the pod. Layers, strongest last:
 *
 * 1. stop() — kills the tunnel, kills the watchdog, `runpodctl pod stop`.
 * 2. process exit/SIGINT/SIGTERM hooks — best-effort cleanup on normal or
 *    signaled exits. Synchronous-on-exit and race-prone on signals; they do
 *    NOT cover kill -9.
 * 3. The watchdog (watchdog.ts, spawned detached + unref'd from start()) —
 *    outlives the CLI. When the parent pid vanishes (kill -9 included) it
 *    stops the pod within ~60s, then removes the sentinel and exits.
 *
 * stop() is unconditional: we ALWAYS stop the pod, whether or not this
 * session started it (startedByUs() is recorded for the audit trail only —
 * the golden rule does not branch on it).
 *
 * runpodctl is assumed on PATH with RUNPOD_API_KEY in its environment; the
 * key is inherited, never logged.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunpodDriverConfig } from "../config.js";
import { httpOk, pollUntil, sleep } from "./health.js";
import {
	defaultExec,
	defaultSpawn,
	terminateChild,
	type ExecRunner,
	type ManagedChild,
	type SpawnRunner,
} from "./runner.js";
import type { ServingDriver, ServingEndpoint } from "./types.js";

/** vLLM on the pod serves on 8000 (spec §7 serve line). */
const POD_VLLM_PORT = 8000;

export interface RunpodDriverOptions {
	exec?: ExecRunner;
	spawn?: SpawnRunner;
	/** process.kill seam (watchdog termination) — injected by tests. */
	killPid?: (pid: number, signal: string) => void;
	sentinelPath?: string;
	watchdogScript?: string;
	/** Time to wait for STOPPED → RUNNING after `pod start`. */
	podReadyTimeoutMs?: number;
	/** Time to wait for vLLM on the pod (model load happens after pod start). */
	healthTimeoutMs?: number;
	pollIntervalMs?: number;
	healthPollIntervalMs?: number;
	/** Grace between SIGTERM and SIGKILL when killing the ssh tunnel. */
	stopGraceMs?: number;
	/** Default true. Tests disable to keep process handlers out of vitest. */
	registerExitHooks?: boolean;
}

export interface RunpodDriver extends ServingDriver {
	/** true when this session issued `pod start` (recorded, never branched on). */
	startedByUs(): boolean;
}

interface PodSsh {
	user: string;
	host: string;
	port: number;
	keyPath?: string;
}

function parsePodStatus(output: string): string {
	const m = /\b(RUNNING|STOPPED|EXITED|TERMINATED|CREATED)\b/i.exec(output);
	if (!m) {
		throw new Error(
			`could not parse pod status from runpodctl output: ${output.trim().slice(0, 200)}`,
		);
	}
	return m[1].toUpperCase();
}

function parseSshInfo(output: string): PodSsh {
	const at = /([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/.exec(output);
	const port = /(?:^|\s)-p\s+(\d+)/.exec(output);
	const key = /(?:^|\s)-i\s+(\S+)/.exec(output);
	if (!at || !port) {
		throw new Error(
			`could not parse \`runpodctl ssh info\` output (expected "ssh user@host -p port"): ` +
				output.trim().slice(0, 200),
		);
	}
	// ssh -i receives no shell tilde expansion when spawned without a shell.
	const keyPath = key?.[1]?.replace(/^~(?=\/)/, os.homedir());
	return { user: at[1], host: at[2], port: Number(port[1]), keyPath };
}

function pickPort(preferred?: number): number {
	if (preferred) return preferred;
	// Below the anvil range (18545+) so both can coexist.
	return 18000 + Math.floor(Math.random() * 500);
}

/** The watchdog runs as plain `node watchdog.ts` via type-stripping. */
function nodeTypeStripArgs(): string[] {
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= 24) return [];
	if (major >= 22) return ["--experimental-strip-types"];
	throw new Error("runpod driver requires Node >= 22.6 (the watchdog runs on type-stripping)");
}

// This repo ships TS sources run by tsx; no build step to resolve .js here.
const defaultWatchdogScript = fileURLToPath(new URL("./watchdog.ts", import.meta.url));

export function createRunpodDriver(
	cfg: RunpodDriverConfig,
	opts: RunpodDriverOptions = {},
): RunpodDriver {
	const exec = opts.exec ?? defaultExec;
	const spawnRunner = opts.spawn ?? defaultSpawn;
	const killPid = opts.killPid ?? ((pid: number, signal: string) => process.kill(pid, signal as NodeJS.Signals));
	const sentinelPath = opts.sentinelPath ?? path.join(os.tmpdir(), `attis-runpod-${cfg.podId}.json`);
	const podReadyTimeoutMs = opts.podReadyTimeoutMs ?? 180_000;
	const healthTimeoutMs = opts.healthTimeoutMs ?? 600_000;
	const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
	const healthPollIntervalMs = opts.healthPollIntervalMs ?? 3_000;
	const stopGraceMs = opts.stopGraceMs ?? 3_000;

	let tunnel: ManagedChild | null = null;
	let tunnelHealthUrl: string | null = null;
	let watchdogPid: number | null = null;
	let stopped = true;
	let weStartedPod = false;

	// --- watchdog + sentinel -------------------------------------------------

	const writeSentinel = (extra: Record<string, unknown> = {}): void => {
		mkdirSync(path.dirname(sentinelPath), { recursive: true });
		writeFileSync(
			sentinelPath,
			`${JSON.stringify({ parentPid: process.pid, podId: cfg.podId, startedAt: new Date().toISOString(), ...extra })}\n`,
		);
	};

	const startWatchdog = (): void => {
		writeSentinel();
		const child = spawnRunner(
			process.execPath,
			[
				...nodeTypeStripArgs(),
				opts.watchdogScript ?? defaultWatchdogScript,
				String(process.pid),
				cfg.podId,
				sentinelPath,
			],
			{ detached: true, stdio: "ignore" },
		);
		child.unref();
		watchdogPid = child.pid ?? null;
		if (watchdogPid !== null) writeSentinel({ watchdogPid });
	};

	const killWatchdog = (): void => {
		if (watchdogPid !== null) {
			try {
				killPid(watchdogPid, "SIGTERM");
			} catch {
				// already gone — the sentinel deletion below also ends it
			}
			watchdogPid = null;
		}
		rmSync(sentinelPath, { force: true });
	};

	// --- runpodctl -----------------------------------------------------------

	const podStatus = async (): Promise<string> => {
		let out: string;
		try {
			const r = await exec("runpodctl", ["pod", "get", cfg.podId]);
			out = `${r.stdout}\n${r.stderr}`;
		} catch (err) {
			throw new Error(
				`\`runpodctl pod get ${cfg.podId}\` failed — check ATTIS_RUNPOD_POD_ID and runpodctl auth (${(err as Error).message})`,
			);
		}
		return parsePodStatus(out);
	};

	const sshInfo = async (): Promise<PodSsh> => {
		const r = await exec("runpodctl", ["ssh", "info", cfg.podId]);
		return parseSshInfo(`${r.stdout}\n${r.stderr}`);
	};

	const stopPodBestEffort = async (): Promise<void> => {
		try {
			await exec("runpodctl", ["pod", "stop", cfg.podId]);
		} catch {
			// failure path of start() — the original error is what matters
		}
	};

	// --- teardown paths ------------------------------------------------------

	const teardown = async (): Promise<void> => {
		killWatchdog();
		const t = tunnel;
		tunnel = null;
		tunnelHealthUrl = null;
		if (t) await terminateChild(t, stopGraceMs);
	};

	/** Synchronous best-effort cleanup for the process "exit" hook. */
	const syncBestEffortStop = (): void => {
		if (stopped) return;
		stopped = true;
		killWatchdog();
		if (tunnel?.pid) {
			try {
				killPid(tunnel.pid, "SIGKILL");
			} catch {
				// best effort
			}
		}
		try {
			execFileSync("runpodctl", ["pod", "stop", cfg.podId], { stdio: "ignore", timeout: 15_000 });
		} catch {
			// nothing more we can do synchronously — the watchdog still covers us
		}
	};

	const onExit = (): void => syncBestEffortStop();
	const onSigint = (): void => void haltWith("SIGINT");
	const onSigterm = (): void => void haltWith("SIGTERM");
	const haltWith = async (sig: "SIGINT" | "SIGTERM"): Promise<void> => {
		await Promise.race([stop(), sleep(10_000)]).catch(() => {});
		// The once-listener already fired, so this re-signal kills us for real.
		process.kill(process.pid, sig);
	};

	let hooksInstalled = false;
	const installExitHooks = (): void => {
		if (hooksInstalled || opts.registerExitHooks === false) return;
		hooksInstalled = true;
		process.once("exit", onExit);
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
	};
	const removeExitHooks = (): void => {
		if (!hooksInstalled) return;
		hooksInstalled = false;
		process.removeListener("exit", onExit);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
	};

	// --- driver --------------------------------------------------------------

	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		removeExitHooks();
		await teardown();
		// Golden rule: unconditional, whether or not we started the pod.
		await exec("runpodctl", ["pod", "stop", cfg.podId]);
	};

	const start = async (): Promise<ServingEndpoint> => {
		if (!stopped) throw new Error("runpod serving driver is already started");
		stopped = false;
		try {
			const initial = await podStatus();
			weStartedPod = false;
			if (initial === "STOPPED" || initial === "EXITED") {
				await exec("runpodctl", ["pod", "start", cfg.podId]);
				weStartedPod = true;
			}
			if (initial !== "RUNNING") {
				await pollUntil(async () => (await podStatus()) === "RUNNING", {
					timeoutMs: podReadyTimeoutMs,
					intervalMs: pollIntervalMs,
					description: `runpod pod ${cfg.podId}`,
				});
			}

			const ssh = await sshInfo();
			startWatchdog();

			const localPort = pickPort(cfg.localPort);
			const args = [
				"-N",
				"-T",
				"-L",
				`${localPort}:localhost:${POD_VLLM_PORT}`,
				"-p",
				String(ssh.port),
			];
			const keyPath = ssh.keyPath ?? cfg.sshKeyPath;
			if (keyPath) args.push("-i", keyPath);
			args.push(
				"-o",
				"BatchMode=yes",
				"-o",
				"StrictHostKeyChecking=accept-new",
				"-o",
				"ExitOnForwardFailure=yes",
				"-o",
				"ConnectTimeout=15",
				"-o",
				"ServerAliveInterval=30",
				`${ssh.user}@${ssh.host}`,
			);
			const t = spawnRunner("ssh", args);
			if (!t.pid) {
				throw new Error("failed to spawn the ssh tunnel — is OpenSSH on PATH?");
			}
			tunnel = t;
			tunnelHealthUrl = `http://127.0.0.1:${localPort}/health`;
			await pollUntil(() => httpOk(tunnelHealthUrl!), {
				timeoutMs: healthTimeoutMs,
				intervalMs: healthPollIntervalMs,
				description: `vLLM on pod ${cfg.podId} (ssh tunnel localhost:${localPort})`,
				isDead: () =>
					t.exitCode !== null
						? `ssh tunnel exited early (code ${t.exitCode}) — check ATTIS_RUNPOD_SSH_KEY and pod ssh access`
						: null,
			});

			installExitHooks();
			return {
				baseUrl: `http://127.0.0.1:${localPort}/v1`,
				model: cfg.model,
				cleanup: stop,
			};
		} catch (err) {
			// Golden rule even on failure: leave nothing running or billing.
			await teardown();
			await stopPodBestEffort();
			stopped = true;
			throw err;
		}
	};

	return {
		name: "runpod",
		start,
		health: () => (tunnelHealthUrl ? httpOk(tunnelHealthUrl) : Promise.resolve(false)),
		stop,
		startedByUs: () => weStartedPod,
	};
}
