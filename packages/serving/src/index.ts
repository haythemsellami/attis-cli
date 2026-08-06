/**
 * @attis/serving — OpenAI-compatible provider factory.
 *
 * One provider shape serves every endpoint attis talks to:
 * - local vLLM (Orgia LoRA modules on :8000; keyless → dummy key placeholder)
 * - DeepSeek v4-pro (spike stand-in + the judge model; thinking toggle via
 *   payload)
 *
 * Config via env: ATTIS_BASE_URL, ATTIS_API_KEY, ATTIS_MODEL.
 * Defaults target the local vLLM server.
 */
import {
	createModels,
	createProvider,
	envApiKeyAuth,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export interface ServingConfig {
	baseUrl: string;
	apiKeyEnv: readonly string[];
	modelId: string;
	contextWindow: number;
	maxTokens: number;
	providerId: string;
}

export function servingConfigFromEnv(): ServingConfig {
	return {
		baseUrl: process.env.ATTIS_BASE_URL ?? "http://localhost:8000/v1",
		apiKeyEnv: ["ATTIS_API_KEY"],
		modelId: process.env.ATTIS_MODEL ?? "orgia",
		contextWindow: Number(process.env.ATTIS_CONTEXT_WINDOW ?? 131072),
		maxTokens: Number(process.env.ATTIS_MAX_TOKENS ?? 32768),
		providerId: "attis-local",
	};
}

export function buildModel(cfg: ServingConfig): Model<"openai-completions"> {
	return {
		id: cfg.modelId,
		name: cfg.modelId,
		api: "openai-completions",
		provider: cfg.providerId,
		baseUrl: cfg.baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: cfg.contextWindow,
		maxTokens: cfg.maxTokens,
		compat: {
			// vLLM and DeepSeek both use max_tokens, no store field, no
			// reasoning-effort knob (auto-detect would guess the opposite).
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsReasoningEffort: false,
		},
	};
}

/**
 * Create the Models registry with the attis provider installed.
 * The returned model is the single active model for this session.
 */
export function createServingModels(cfg: ServingConfig = servingConfigFromEnv()): {
	models: Models;
	model: Model<"openai-completions">;
} {
	const model = buildModel(cfg);
	const models = createModels();
	models.setProvider(
		createProvider({
			id: cfg.providerId,
			name: cfg.providerId,
			baseUrl: cfg.baseUrl,
			auth: { apiKey: envApiKeyAuth("attis endpoint API key", cfg.apiKeyEnv) },
			models: [model],
			api: openAICompletionsApi(),
		}),
	);
	return { models, model };
}

export type { Models, Model };

// --- v2 serving-manager (roadmap item 4): drivers + lifecycle manager ---
export { createServingManager } from "./manager.js";
export type { ServingManager, ServingManagerOptions } from "./manager.js";
export {
	envDriverConfigFromEnv,
	localDriverConfigFromEnv,
	runpodDriverConfigFromEnv,
} from "./config.js";
export type { EnvDriverConfig, LocalDriverConfig, RunpodDriverConfig } from "./config.js";
export { createEnvDriver } from "./drivers/env.js";
export { createLocalDriver } from "./drivers/local.js";
export type { LocalDriverOptions } from "./drivers/local.js";
export { createRunpodDriver } from "./drivers/runpod.js";
export type { RunpodDriver, RunpodDriverOptions } from "./drivers/runpod.js";
export type { DriverName, ServingDriver, ServingEndpoint } from "./drivers/types.js";
export type {
	CommandResult,
	ExecRunner,
	ManagedChild,
	SpawnOptions,
	SpawnRunner,
} from "./drivers/runner.js";
