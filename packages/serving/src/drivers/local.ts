/**
 * local driver — run vLLM as a subprocess on this machine.
 *
 * start() spawns `vllm serve <model> --port N [--enable-lora --lora-modules …]`
 * and polls /health until the server is ready (model load can take minutes).
 * stop() is SIGTERM with a SIGKILL escalation, same shape as the anvil
 * manager in @attis/fork.
 */
import type { LocalDriverConfig } from "../config.js";
import { healthUrlFor, httpOk, pollUntil } from "./health.js";
import { defaultSpawn, terminateChild, type ManagedChild, type SpawnRunner } from "./runner.js";
import type { ServingDriver, ServingEndpoint } from "./types.js";

export interface LocalDriverOptions {
	spawn?: SpawnRunner;
	/** vLLM loads weights before serving; default is generous on purpose. */
	readyTimeoutMs?: number;
	pollIntervalMs?: number;
	/** Grace between SIGTERM and SIGKILL on stop(). */
	stopGraceMs?: number;
}

export function createLocalDriver(
	cfg: LocalDriverConfig,
	opts: LocalDriverOptions = {},
): ServingDriver {
	const spawnRunner = opts.spawn ?? defaultSpawn;
	const readyTimeoutMs = opts.readyTimeoutMs ?? 600_000;
	const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
	const stopGraceMs = opts.stopGraceMs ?? 5_000;

	const baseUrl = `http://127.0.0.1:${cfg.port}/v1`;
	const healthUrl = healthUrlFor(baseUrl);

	let child: ManagedChild | null = null;
	let stopped = true;

	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		const c = child;
		child = null;
		if (c) await terminateChild(c, stopGraceMs);
	};

	const start = async (): Promise<ServingEndpoint> => {
		if (child) throw new Error("local serving driver is already started");
		stopped = false;
		const args = ["serve", cfg.modelPath, "--port", String(cfg.port)];
		if (cfg.loraModules) args.push("--enable-lora", "--lora-modules", cfg.loraModules);
		const c = spawnRunner("vllm", args);
		if (!c.pid) throw new Error("failed to spawn `vllm serve` — is vllm installed and on PATH?");
		child = c;
		try {
			await pollUntil(() => httpOk(healthUrl), {
				timeoutMs: readyTimeoutMs,
				intervalMs: pollIntervalMs,
				description: `vllm serve on port ${cfg.port}`,
				isDead: () =>
					c.exitCode !== null
						? `vllm exited early (code ${c.exitCode}) — check ATTIS_VLLM_MODEL_PATH and the vllm flags`
						: null,
			});
		} catch (err) {
			await stop();
			throw err;
		}
		return { baseUrl, model: cfg.model, cleanup: stop };
	};

	return {
		name: "local",
		start,
		health: () => httpOk(healthUrl),
		stop,
	};
}
