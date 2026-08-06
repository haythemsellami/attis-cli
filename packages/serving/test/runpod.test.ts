/**
 * runpod driver — pod lifecycle + tunnel + watchdog, all over faked
 * runpodctl/ssh processes and a stubbed fetch. Nothing real is spawned,
 * no real pod is touched.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runpodDriverConfigFromEnv } from "../src/config.js";
import { createRunpodDriver, type RunpodDriverOptions } from "../src/drivers/runpod.js";
import {
	createFakeExec,
	createFakeSpawn,
	execLines,
	FakeChild,
} from "./fakes.js";

const CFG = runpodDriverConfigFromEnv({
	RUNPOD_API_KEY: "test-key",
	ATTIS_RUNPOD_POD_ID: "pod-1",
	ATTIS_RUNPOD_SSH_KEY: "/keys/pod_key",
	ATTIS_MODEL: "orgia",
});

const SSH_LINE = "ssh root@203.0.113.10 -p 12345 -i ~/.ssh/id_ed25519";

interface Rig {
	driver: ReturnType<typeof createRunpodDriver>;
	execCalls: ReturnType<typeof createFakeExec>["calls"];
	spawnCalls: ReturnType<typeof createFakeSpawn>["calls"];
	killPidCalls: [number, string][];
	watchdogChild: FakeChild;
	tunnelChild: FakeChild;
	sentinelPath: string;
	tmp: string;
}

function setup(opts: {
	statuses: string[];
	sshInfo?: string;
	healthy: boolean;
	/** Make `pod get` fail with this error (bad pod id, auth, network). */
	podGetError?: string;
}): Rig {
	const tmp = mkdtempSync(path.join(tmpdir(), "attis-runpod-test-"));
	const sentinelPath = path.join(tmp, "sentinel.json");
	let statusIdx = 0;
	const { exec, calls: execCalls } = createFakeExec(async (command, args) => {
		const key = args.slice(0, 2).join(" ");
		if (key === "pod get") {
			if (opts.podGetError) throw new Error(opts.podGetError);
			const s = opts.statuses[Math.min(statusIdx++, opts.statuses.length - 1)];
			return { stdout: `POD ID  STATUS\npod-1   ${s}\n`, stderr: "" };
		}
		if (key === "pod start") return { stdout: "started\n", stderr: "" };
		if (key === "pod stop") return { stdout: "stopped\n", stderr: "" };
		if (key === "ssh info") return { stdout: `${opts.sshInfo ?? SSH_LINE}\n`, stderr: "" };
		throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
	});

	const watchdogChild = new FakeChild(9001);
	const tunnelChild = new FakeChild(9002);
	const { spawn, calls: spawnCalls } = createFakeSpawn((command) =>
		command === "ssh" ? tunnelChild : watchdogChild,
	);
	const killPidCalls: [number, string][] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			if (!opts.healthy) throw new Error("no server");
			return new Response("ok");
		}),
	);

	const driverOpts: RunpodDriverOptions = {
		exec,
		spawn,
		killPid: (pid, signal) => {
			killPidCalls.push([pid, signal]);
		},
		sentinelPath,
		podReadyTimeoutMs: 200,
		healthTimeoutMs: 200,
		pollIntervalMs: 5,
		healthPollIntervalMs: 5,
		stopGraceMs: 20,
		registerExitHooks: false,
	};
	return {
		driver: createRunpodDriver(CFG, driverOpts),
		execCalls,
		spawnCalls,
		killPidCalls,
		watchdogChild,
		tunnelChild,
		sentinelPath,
		tmp,
	};
}

let rig: Rig | null = null;
beforeEach(() => {
	rig = null;
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (rig) rmSync(rig.tmp, { recursive: true, force: true });
});

describe("runpodDriverConfigFromEnv", () => {
	it("requires RUNPOD_API_KEY and ATTIS_RUNPOD_POD_ID, naming both", () => {
		expect(() => runpodDriverConfigFromEnv({})).toThrow(
			/requires RUNPOD_API_KEY and ATTIS_RUNPOD_POD_ID/,
		);
		expect(() => runpodDriverConfigFromEnv({ RUNPOD_API_KEY: "k" })).toThrow(/ATTIS_RUNPOD_POD_ID/);
		expect(() => runpodDriverConfigFromEnv({ ATTIS_RUNPOD_POD_ID: "p" })).toThrow(/RUNPOD_API_KEY/);
	});
});

describe("runpod driver start flow", () => {
	it("starts a STOPPED pod, opens a tunnel, and serves an endpoint", async () => {
		rig = setup({ statuses: ["STOPPED", "RUNNING"], healthy: true });
		const ep = await rig.driver.start();

		expect(execLines(rig.execCalls)).toEqual([
			"pod get pod-1",
			"pod start pod-1",
			"pod get pod-1",
			"ssh info pod-1",
		]);
		expect(rig.driver.startedByUs()).toBe(true);

		const tunnel = rig.spawnCalls.find((c) => c.command === "ssh")!;
		expect(tunnel.args).toContain("-N");
		const lIdx = tunnel.args.indexOf("-L");
		expect(tunnel.args[lIdx + 1]).toMatch(/^\d+:localhost:8000$/);
		const pIdx = tunnel.args.indexOf("-p");
		expect(tunnel.args[pIdx + 1]).toBe("12345");
		expect(tunnel.args.at(-1)).toBe("root@203.0.113.10");

		expect(ep.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
		expect(ep.model).toBe("orgia");
		const localPort = ep.baseUrl.match(/:(\d+)\/v1/)![1];
		expect(tunnel.args[lIdx + 1]).toBe(`${localPort}:localhost:8000`);
		expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`http://127.0.0.1:${localPort}/health`);

		await rig.driver.stop();
	});

	it("does not call pod start when the pod is already RUNNING, but always stops", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true });
		await rig.driver.start();
		expect(execLines(rig.execCalls)).not.toContain("pod start pod-1");
		expect(rig.driver.startedByUs()).toBe(false);
		// Golden rule: stop is unconditional even though we did not start it.
		await rig.driver.stop();
		expect(execLines(rig.execCalls)).toContain("pod stop pod-1");
	});

	it("uses the key from ssh info (tilde-expanded) over ATTIS_RUNPOD_SSH_KEY", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true });
		await rig.driver.start();
		const tunnel = rig.spawnCalls.find((c) => c.command === "ssh")!;
		const iIdx = tunnel.args.indexOf("-i");
		expect(tunnel.args[iIdx + 1]).toMatch(/^\//); // ~ expanded to an absolute home path
		expect(tunnel.args[iIdx + 1]).toMatch(/\.ssh\/id_ed25519$/);
		expect(tunnel.args[iIdx + 1]).not.toBe("/keys/pod_key");
		await rig.driver.stop();
	});

	it("falls back to ATTIS_RUNPOD_SSH_KEY when ssh info has no -i", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true, sshInfo: "ssh root@203.0.113.10 -p 12345" });
		await rig.driver.start();
		const tunnel = rig.spawnCalls.find((c) => c.command === "ssh")!;
		const iIdx = tunnel.args.indexOf("-i");
		expect(tunnel.args[iIdx + 1]).toBe("/keys/pod_key");
		await rig.driver.stop();
	});

	it("fails with a clear error when the pod id is wrong (pod get fails)", async () => {
		rig = setup({ statuses: [], healthy: true, podGetError: "exit 1: pod not found" });
		await expect(rig.driver.start()).rejects.toThrow(/check ATTIS_RUNPOD_POD_ID/);
	});

	it("times out clearly and stops the pod when it never reaches RUNNING", async () => {
		rig = setup({ statuses: ["STOPPED", "CREATED"], healthy: true });
		await expect(rig.driver.start()).rejects.toThrow(
			/runpod pod pod-1 did not become ready in 200ms/,
		);
		expect(execLines(rig.execCalls)).toContain("pod stop pod-1");
	});

	it("fails clearly and stops the pod when ssh info is unparseable", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true, sshInfo: "ssh not available yet" });
		await expect(rig.driver.start()).rejects.toThrow(/could not parse `runpodctl ssh info`/);
		expect(execLines(rig.execCalls)).toContain("pod stop pod-1");
	});

	it("stops the pod and kills the tunnel when vLLM never becomes healthy", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: false });
		await expect(rig.driver.start()).rejects.toThrow(/did not become ready in 200ms/);
		expect(execLines(rig.execCalls)).toContain("pod stop pod-1");
		expect(rig.tunnelChild.killCalls).toContain("SIGTERM");
		expect(existsSync(rig.sentinelPath)).toBe(false);
	});
});

describe("runpod watchdog", () => {
	it("spawns detached, ignored, unref'd, with parent pid + pod id + sentinel path", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true });
		await rig.driver.start();

		const wd = rig.spawnCalls.find((c) => c.command !== "ssh")!;
		expect(wd.command).toBe(process.execPath);
		expect(wd.args.at(-3)).toBe(String(process.pid));
		expect(wd.args.at(-2)).toBe("pod-1");
		expect(wd.args.at(-1)).toBe(rig.sentinelPath);
		expect(wd.args[wd.args.length - 4]).toMatch(/watchdog\.ts$/);
		expect(wd.opts).toEqual({ detached: true, stdio: "ignore" });
		expect(rig.watchdogChild.unrefCalled).toBe(true);

		const sentinel = JSON.parse(readFileSync(rig.sentinelPath, "utf-8"));
		expect(sentinel.parentPid).toBe(process.pid);
		expect(sentinel.podId).toBe("pod-1");
		expect(sentinel.watchdogPid).toBe(9001);

		await rig.driver.stop();
	});

	it("normal stop() kills the watchdog via the sentinel pid and removes the sentinel", async () => {
		rig = setup({ statuses: ["RUNNING"], healthy: true });
		await rig.driver.start();
		await rig.driver.stop();

		expect(rig.killPidCalls).toContainEqual([9001, "SIGTERM"]);
		expect(existsSync(rig.sentinelPath)).toBe(false);
		expect(rig.tunnelChild.killCalls).toContain("SIGTERM");
		expect(execLines(rig.execCalls).at(-1)).toBe("pod stop pod-1");

		// stop() is idempotent — no further runpodctl calls
		const n = rig.execCalls.length;
		await rig.driver.stop();
		expect(rig.execCalls).toHaveLength(n);
	});
});
