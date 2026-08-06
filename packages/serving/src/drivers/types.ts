/**
 * Serving driver contract (roadmap item 4).
 *
 * A driver owns the lifecycle of the model endpoint attis talks to:
 * start() brings it up (or verifies it is up), stop() tears down whatever
 * start() acquired. stop() must be idempotent — the manager's guaranteed-
 * stop paths may call it more than once.
 */

/** A ready-to-use OpenAI-compatible endpoint. */
export interface ServingEndpoint {
	/** OpenAI-compatible base URL, e.g. http://127.0.0.1:8000/v1 */
	baseUrl: string;
	/** Model id to request at the endpoint (e.g. the LoRA module name). */
	model: string;
	/** Release what start() acquired. Equivalent to the driver's stop(). */
	cleanup(): Promise<void>;
}

export interface ServingDriver {
	name: string;
	start(): Promise<ServingEndpoint>;
	health(): Promise<boolean>;
	stop(): Promise<void>;
}

export type DriverName = "env" | "local" | "runpod";
