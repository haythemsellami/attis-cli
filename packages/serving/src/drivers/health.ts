/**
 * Health polling shared by the drivers. vLLM exposes GET /health at the
 * server root (baseUrl minus the /v1 API prefix).
 */
export async function httpOk(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return resp.ok;
	} catch {
		return false;
	}
}

/** http://host:8000/v1 → http://host:8000/health */
export function healthUrlFor(baseUrl: string): string {
	let base = baseUrl.replace(/\/+$/, "");
	if (base.endsWith("/v1")) base = base.slice(0, -"/v1".length);
	return `${base}/health`;
}

export interface PollOptions {
	timeoutMs: number;
	intervalMs: number;
	/** Used in the timeout error, e.g. "vllm serve on port 8000". */
	description: string;
	/** Return an error message if the thing being polled died on its own. */
	isDead?: () => string | null;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil(ok: () => Promise<boolean>, opts: PollOptions): Promise<void> {
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		if (await ok()) return;
		const dead = opts.isDead?.();
		if (dead) throw new Error(dead);
		await sleep(opts.intervalMs);
	}
	throw new Error(`${opts.description} did not become ready in ${opts.timeoutMs}ms`);
}
