/**
 * env driver — the v1 behavior as a driver: the endpoint already exists
 * (someone else runs vLLM), start() is a health check only, stop() is a
 * no-op (we own nothing).
 */
import type { EnvDriverConfig } from "../config.js";
import { healthUrlFor, httpOk } from "./health.js";
import type { ServingDriver } from "./types.js";

export function createEnvDriver(cfg: EnvDriverConfig): ServingDriver {
	const healthUrl = healthUrlFor(cfg.baseUrl);
	return {
		name: "env",
		start: async () => {
			if (!(await httpOk(healthUrl))) {
				throw new Error(
					`serving endpoint ${cfg.baseUrl} is not healthy (${healthUrl} unreachable) — ` +
						"start vLLM or fix ATTIS_VLLM_BASE_URL",
				);
			}
			return { baseUrl: cfg.baseUrl, model: cfg.model, cleanup: async () => {} };
		},
		health: () => httpOk(healthUrl),
		stop: async () => {},
	};
}
