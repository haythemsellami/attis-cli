/**
 * env driver — the v1 "endpoint already exists" behavior behind the driver
 * interface. fetch is stubbed; nothing real is polled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { envDriverConfigFromEnv } from "../src/config.js";
import { createEnvDriver } from "../src/drivers/env.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: () => Promise<Response>) {
	vi.stubGlobal("fetch", vi.fn(impl));
}

describe("envDriverConfigFromEnv", () => {
	it("prefers ATTIS_VLLM_BASE_URL, falls back to ATTIS_BASE_URL, then the local default", () => {
		expect(envDriverConfigFromEnv({}).baseUrl).toBe("http://localhost:8000/v1");
		expect(envDriverConfigFromEnv({ ATTIS_BASE_URL: "http://a:1/v1" }).baseUrl).toBe(
			"http://a:1/v1",
		);
		expect(
			envDriverConfigFromEnv({
				ATTIS_BASE_URL: "http://a:1/v1",
				ATTIS_VLLM_BASE_URL: "http://b:2/v1",
			}).baseUrl,
		).toBe("http://b:2/v1");
	});

	it("defaults the model to orgia, overridable via ATTIS_MODEL", () => {
		expect(envDriverConfigFromEnv({}).model).toBe("orgia");
		expect(envDriverConfigFromEnv({ ATTIS_MODEL: "m1" }).model).toBe("m1");
	});
});

describe("env driver", () => {
	it("start() health-checks the endpoint and returns it", async () => {
		stubFetch(async () => new Response("ok", { status: 200 }));
		const d = createEnvDriver(
			envDriverConfigFromEnv({ ATTIS_VLLM_BASE_URL: "http://gpu:8000/v1", ATTIS_MODEL: "m1" }),
		);
		const ep = await d.start();
		expect(ep.baseUrl).toBe("http://gpu:8000/v1");
		expect(ep.model).toBe("m1");
		// health is checked at the server root, not under /v1
		expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://gpu:8000/health");
		await expect(d.health()).resolves.toBe(true);
	});

	it("start() fails with a clear error when the endpoint is unreachable", async () => {
		stubFetch(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		const d = createEnvDriver(envDriverConfigFromEnv({ ATTIS_VLLM_BASE_URL: "http://gpu:8000/v1" }));
		await expect(d.start()).rejects.toThrow(/not healthy.*ATTIS_VLLM_BASE_URL/);
		await expect(d.health()).resolves.toBe(false);
	});

	it("stop() is a no-op (the endpoint is owned elsewhere)", async () => {
		const d = createEnvDriver(envDriverConfigFromEnv({}));
		await expect(d.stop()).resolves.toBeUndefined();
		await expect(d.stop()).resolves.toBeUndefined();
	});
});
