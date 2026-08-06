/**
 * Serving config — environment only, validated at driver-selection time.
 *
 * Rules (AGENTS.md): never hardcode secrets, never log their values.
 * Errors name the missing variable and what it is for — never its value.
 */

export type EnvMap = Record<string, string | undefined>;

export interface EnvDriverConfig {
	baseUrl: string;
	model: string;
}

export interface LocalDriverConfig {
	/** Model path or HF id handed to `vllm serve`. */
	modelPath: string;
	/** Verbatim value for `--lora-modules` (e.g. "orgia=/path/to/adapter"). */
	loraModules?: string;
	port: number;
	/** Model id attis requests at the endpoint (usually the LoRA name). */
	model: string;
}

export interface RunpodDriverConfig {
	/** Never logged; passed to runpodctl via the inherited environment. */
	apiKey: string;
	podId: string;
	/** Path to the SSH private key; `runpodctl ssh info` may supply one too. */
	sshKeyPath?: string;
	/** Local end of the SSH tunnel; random high port when unset. */
	localPort?: number;
	/** Model id attis requests at the endpoint (the LoRA name on the pod). */
	model: string;
}

export function envDriverConfigFromEnv(env: EnvMap): EnvDriverConfig {
	return {
		// ATTIS_VLLM_BASE_URL is the v2 name; ATTIS_BASE_URL kept for v1 compat.
		baseUrl: env.ATTIS_VLLM_BASE_URL ?? env.ATTIS_BASE_URL ?? "http://localhost:8000/v1",
		model: env.ATTIS_MODEL ?? "orgia",
	};
}

function parsePort(raw: string | undefined, fallback: number, varName: string): number {
	if (raw === undefined) return fallback;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`${varName} must be a valid TCP port, got "${raw}"`);
	}
	return port;
}

export function localDriverConfigFromEnv(env: EnvMap): LocalDriverConfig {
	const modelPath = env.ATTIS_VLLM_MODEL_PATH;
	if (!modelPath) {
		throw new Error(
			"local serving driver requires ATTIS_VLLM_MODEL_PATH " +
				"(model path or HF id for `vllm serve`)",
		);
	}
	return {
		modelPath,
		loraModules: env.ATTIS_VLLM_LORA_MODULES || undefined,
		port: parsePort(env.ATTIS_VLLM_PORT, 8000, "ATTIS_VLLM_PORT"),
		model: env.ATTIS_MODEL ?? "orgia",
	};
}

export function runpodDriverConfigFromEnv(env: EnvMap): RunpodDriverConfig {
	const missing: string[] = [];
	if (!env.RUNPOD_API_KEY) missing.push("RUNPOD_API_KEY");
	if (!env.ATTIS_RUNPOD_POD_ID) missing.push("ATTIS_RUNPOD_POD_ID");
	if (missing.length > 0) {
		throw new Error(
			`runpod serving driver requires ${missing.join(" and ")} in the environment ` +
				"(pod id of the vLLM pod + API key for runpodctl)",
		);
	}
	return {
		apiKey: env.RUNPOD_API_KEY!,
		podId: env.ATTIS_RUNPOD_POD_ID!,
		sshKeyPath: env.ATTIS_RUNPOD_SSH_KEY || undefined,
		localPort: env.ATTIS_RUNPOD_LOCAL_PORT
			? parsePort(env.ATTIS_RUNPOD_LOCAL_PORT, 0, "ATTIS_RUNPOD_LOCAL_PORT")
			: undefined,
		model: env.ATTIS_MODEL ?? "orgia",
	};
}
