/**
 * Serving manager — driver selection, single-active-driver enforcement,
 * config validation at selection time, and withEndpoint's guaranteed stop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServingManager, type ServingManagerOptions } from "../src/manager.js";
import type { DriverName } from "../src/drivers/types.js";
import { createFakeExec, createFakeSpawn, execLines, FakeChild } from "./fakes.js";

afterEach(() => vi.unstubAllGlobals());

describe("createServingManager — driver selection", () => {
	it("builds each driver by name", async () => {
		const m = createServingManager({
			env: { ATTIS_VLLM_MODEL_PATH: "/m", RUNPOD_API_KEY: "k", ATTIS_RUNPOD_POD_ID: "p" },
			runpod: { registerExitHooks: false },
		});
		for (const name of ["env", "local", "runpod"] as const) {
			const d = m.driver(name);
			expect(d.name).toBe(name);
			await d.stop(); // never started → no-op, releases the active slot
		}
	});

	it("rejects an unknown driver name with the valid choices", () => {
		const m = createServingManager({ env: {} });
		expect(() => m.driver("bogus" as DriverName)).toThrow(
			/unknown serving driver "bogus" — expected env\|local\|runpod/,
		);
	});

	it("enforces a single active driver until stop()", async () => {
		const m = createServingManager({ env: {} });
		const d = m.driver("env");
		expect(m.active?.name).toBe("env");
		expect(() => m.driver("env")).toThrow(/"env" is still active/);
		await d.stop();
		expect(m.active).toBeNull();
		expect(m.driver("env").name).toBe("env");
	});

	it("validates runpod env at selection time, before anything spawns", () => {
		expect(() => createServingManager({ env: {} }).driver("runpod")).toThrow(
			/requires RUNPOD_API_KEY and ATTIS_RUNPOD_POD_ID/,
		);
		expect(() =>
			createServingManager({ env: { RUNPOD_API_KEY: "k" } }).driver("runpod"),
		).toThrow(/ATTIS_RUNPOD_POD_ID/);
	});

	it("validates local env at selection time", () => {
		expect(() => createServingManager({ env: {} }).driver("local")).toThrow(
			/ATTIS_VLLM_MODEL_PATH/,
		);
	});
});

describe("withEndpoint", () => {
	function localRig() {
		const child = new FakeChild();
		child.onKill = (signal) => {
			if (signal === "SIGTERM") child.emitExit(0);
		};
		const { spawn } = createFakeSpawn(() => child);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
		const opts: ServingManagerOptions = {
			env: { ATTIS_VLLM_MODEL_PATH: "/m", ATTIS_VLLM_PORT: "8123" },
			local: { spawn, readyTimeoutMs: 500, pollIntervalMs: 5, stopGraceMs: 20 },
		};
		return { manager: createServingManager(opts), child };
	}

	it("starts the driver, hands fn the endpoint, stops afterwards", async () => {
		const { manager, child } = localRig();
		const seen: string[] = [];
		const result = await manager.withEndpoint("local", async (ep) => {
			seen.push(ep.baseUrl, ep.model);
			return 42;
		});
		expect(result).toBe(42);
		expect(seen).toEqual(["http://127.0.0.1:8123/v1", "orgia"]);
		expect(child.killCalls).toContain("SIGTERM"); // stopped
		expect(manager.active).toBeNull();
	});

	it("guarantees stop() in a finally when fn throws", async () => {
		const { manager, child } = localRig();
		await expect(
			manager.withEndpoint("local", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(child.killCalls).toContain("SIGTERM");
		expect(manager.active).toBeNull();
	});

	it("releases the driver when start() fails", async () => {
		const child = new FakeChild();
		const { spawn } = createFakeSpawn(() => child);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("down");
			}),
		);
		const manager = createServingManager({
			env: { ATTIS_VLLM_MODEL_PATH: "/m" },
			local: { spawn, readyTimeoutMs: 30, pollIntervalMs: 5, stopGraceMs: 10 },
		});
		await expect(manager.withEndpoint("local", async () => {})).rejects.toThrow(
			/did not become ready/,
		);
		expect(manager.active).toBeNull(); // usable again
	});

	it("stops the pod when fn throws under the runpod driver", async () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "attis-manager-test-"));
		try {
			const { exec, calls } = createFakeExec(async (_command, args) => {
				const key = args.slice(0, 2).join(" ");
				if (key === "pod get") return { stdout: "pod-1 RUNNING\n", stderr: "" };
				if (key === "ssh info") return { stdout: "ssh root@203.0.113.10 -p 12345\n", stderr: "" };
				return { stdout: "", stderr: "" };
			});
			const { spawn } = createFakeSpawn((command) =>
				command === "ssh" ? new FakeChild(8002) : new FakeChild(8001),
			);
			vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
			const manager = createServingManager({
				env: { RUNPOD_API_KEY: "k", ATTIS_RUNPOD_POD_ID: "pod-1" },
				runpod: {
					exec,
					spawn,
					killPid: () => {},
					sentinelPath: path.join(tmp, "sentinel.json"),
					podReadyTimeoutMs: 100,
					healthTimeoutMs: 100,
					pollIntervalMs: 5,
					healthPollIntervalMs: 5,
					stopGraceMs: 20,
					registerExitHooks: false,
				},
			});
			await expect(
				manager.withEndpoint("runpod", async () => {
					throw new Error("audit crashed");
				}),
			).rejects.toThrow("audit crashed");
			expect(execLines(calls).at(-1)).toBe("pod stop pod-1");
			expect(manager.active).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
