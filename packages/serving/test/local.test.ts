/**
 * local driver — vllm subprocess lifecycle with a faked spawn and stubbed
 * fetch: spawn args, health polling, early-exit and timeout errors, and
 * SIGTERM→SIGKILL stop escalation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDriverConfigFromEnv } from "../src/config.js";
import { createLocalDriver } from "../src/drivers/local.js";
import { createFakeSpawn, FakeChild } from "./fakes.js";

const CFG = localDriverConfigFromEnv({
	ATTIS_VLLM_MODEL_PATH: "/models/qwen",
	ATTIS_VLLM_PORT: "8123",
	ATTIS_MODEL: "orgia",
});
const CFG_LORA = localDriverConfigFromEnv({
	ATTIS_VLLM_MODEL_PATH: "/models/qwen",
	ATTIS_VLLM_PORT: "8123",
	ATTIS_VLLM_LORA_MODULES: "orgia=/adapters/v61",
	ATTIS_MODEL: "orgia",
});

const FAST = { readyTimeoutMs: 500, pollIntervalMs: 5, stopGraceMs: 20 } as const;

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: () => Promise<Response>) {
	vi.stubGlobal("fetch", vi.fn(impl));
}

describe("localDriverConfigFromEnv", () => {
	it("requires ATTIS_VLLM_MODEL_PATH with a clear error", () => {
		expect(() => localDriverConfigFromEnv({})).toThrow(/ATTIS_VLLM_MODEL_PATH/);
	});

	it("rejects a garbage port with a clear error", () => {
		expect(() =>
			localDriverConfigFromEnv({ ATTIS_VLLM_MODEL_PATH: "/m", ATTIS_VLLM_PORT: "nope" }),
		).toThrow(/ATTIS_VLLM_PORT/);
	});
});

describe("local driver", () => {
	it("spawns `vllm serve` with model, port, and lora flags", async () => {
		const child = new FakeChild();
		const { spawn, calls } = createFakeSpawn(() => child);
		stubFetch(async () => new Response("ok"));
		const d = createLocalDriver(CFG_LORA, { spawn, ...FAST });
		const ep = await d.start();
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toBe("vllm");
		expect(calls[0].args).toEqual([
			"serve",
			"/models/qwen",
			"--port",
			"8123",
			"--enable-lora",
			"--lora-modules",
			"orgia=/adapters/v61",
		]);
		expect(ep.baseUrl).toBe("http://127.0.0.1:8123/v1");
		expect(ep.model).toBe("orgia");
		await d.stop();
	});

	it("omits lora flags when no modules are configured", async () => {
		const child = new FakeChild();
		const { spawn, calls } = createFakeSpawn(() => child);
		stubFetch(async () => new Response("ok"));
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await d.start();
		expect(calls[0].args).toEqual(["serve", "/models/qwen", "--port", "8123"]);
		await d.stop();
	});

	it("polls /health until the server is ready", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		let attempts = 0;
		stubFetch(async () => {
			attempts++;
			if (attempts < 3) throw new Error("not up yet");
			return new Response("ok");
		});
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await d.start();
		expect(attempts).toBe(3);
		expect(vi.mocked(fetch).mock.calls.every((c) => c[0] === "http://127.0.0.1:8123/health")).toBe(
			true,
		);
		await d.stop();
	});

	it("fails fast with a clear error when vllm exits early", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		let first = true;
		stubFetch(async () => {
			if (first) {
				first = false;
				child.emitExit(1);
			}
			throw new Error("down");
		});
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await expect(d.start()).rejects.toThrow(/vllm exited early \(code 1\)/);
	});

	it("times out with a clear error and kills the process", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		stubFetch(async () => {
			throw new Error("never up");
		});
		const d = createLocalDriver(CFG, { spawn, ...FAST, readyTimeoutMs: 40 });
		await expect(d.start()).rejects.toThrow(/vllm serve on port 8123 did not become ready in 40ms/);
		expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("stop() sends SIGTERM and resolves when the child exits", async () => {
		const child = new FakeChild();
		child.onKill = (signal) => {
			if (signal === "SIGTERM") child.emitExit(0);
		};
		const { spawn } = createFakeSpawn(() => child);
		stubFetch(async () => new Response("ok"));
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await d.start();
		await d.stop();
		expect(child.killCalls).toEqual(["SIGTERM"]);
		await d.stop(); // idempotent
		expect(child.killCalls).toEqual(["SIGTERM"]);
	});

	it("stop() escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		stubFetch(async () => new Response("ok"));
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await d.start();
		await d.stop();
		expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("refuses a second start() while running", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		stubFetch(async () => new Response("ok"));
		const d = createLocalDriver(CFG, { spawn, ...FAST });
		await d.start();
		await expect(d.start()).rejects.toThrow(/already started/);
		await d.stop();
	});
});
