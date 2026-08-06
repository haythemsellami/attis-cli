/**
 * Serving manager (roadmap item 4) — driver selection by name, one active
 * driver at a time, and withEndpoint() which guarantees stop() in a finally
 * so a session can never leak a running server or a billing pod.
 */
import {
	envDriverConfigFromEnv,
	localDriverConfigFromEnv,
	runpodDriverConfigFromEnv,
	type EnvMap,
} from "./config.js";
import { createEnvDriver } from "./drivers/env.js";
import { createLocalDriver, type LocalDriverOptions } from "./drivers/local.js";
import { createRunpodDriver, type RunpodDriverOptions } from "./drivers/runpod.js";
import type { DriverName, ServingDriver, ServingEndpoint } from "./drivers/types.js";

export interface ServingManagerOptions {
	/** env map to read — tests inject a fake; defaults to process.env. */
	env?: EnvMap;
	local?: LocalDriverOptions;
	runpod?: RunpodDriverOptions;
}

export interface ServingManager {
	/** The currently active driver, if any. */
	readonly active: ServingDriver | null;
	/**
	 * Select and activate a driver by name ("env" | "local" | "runpod").
	 * Config is validated here — missing env vars throw before anything
	 * spawns. Throws if another driver is still active.
	 */
	driver(name: DriverName): ServingDriver;
	/** start() → fn(endpoint) → stop() in a finally, whatever fn does. */
	withEndpoint<T>(name: DriverName, fn: (endpoint: ServingEndpoint) => Promise<T>): Promise<T>;
}

export function createServingManager(opts: ServingManagerOptions = {}): ServingManager {
	const env = opts.env ?? process.env;
	let active: ServingDriver | null = null;

	const build = (name: DriverName): ServingDriver => {
		switch (name) {
			case "env":
				return createEnvDriver(envDriverConfigFromEnv(env));
			case "local":
				return createLocalDriver(localDriverConfigFromEnv(env), opts.local);
			case "runpod":
				return createRunpodDriver(runpodDriverConfigFromEnv(env), opts.runpod);
			default:
				throw new Error(`unknown serving driver "${String(name)}" — expected env|local|runpod`);
		}
	};

	const manager: ServingManager = {
		get active() {
			return active;
		},
		driver(name) {
			if (active) {
				throw new Error(
					`serving driver "${active.name}" is still active — stop() it before starting another`,
				);
			}
			const d = build(name);
			const tracked: ServingDriver = {
				name: d.name,
				start: () => d.start(),
				health: () => d.health(),
				stop: async () => {
					try {
						await d.stop();
					} finally {
						if (active === tracked) active = null;
					}
				},
			};
			active = tracked;
			return tracked;
		},
		async withEndpoint(name, fn) {
			const d = manager.driver(name);
			let endpoint: ServingEndpoint;
			try {
				endpoint = await d.start();
			} catch (err) {
				// start() cleans up after itself; stop() releases the active slot.
				await d.stop().catch(() => {});
				throw err;
			}
			try {
				return await fn(endpoint);
			} finally {
				await d.stop();
			}
		},
	};
	return manager;
}
