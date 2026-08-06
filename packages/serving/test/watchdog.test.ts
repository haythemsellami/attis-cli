/**
 * Watchdog integration — the kill -9 guarantee, exercised for real: a
 * detached watchdog process, a fake runpodctl on PATH, a victim parent
 * killed with SIGKILL. No real pod: the fake runpodctl records the stop.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const WATCHDOG = fileURLToPath(new URL("../src/drivers/watchdog.ts", import.meta.url));
const INTERVAL_MS = "50";

interface WdRig {
	tmp: string;
	sentinelPath: string;
	stopMarker: string;
	runpodctlLog: string;
}

function setup(podId: string): WdRig {
	const tmp = mkdtempSync(path.join(tmpdir(), "attis-watchdog-test-"));
	const sentinelPath = path.join(tmp, "sentinel.json");
	const stopMarker = path.join(tmp, "stopped");
	const runpodctlLog = path.join(tmp, "runpodctl.log");
	// Fake runpodctl: record every call, touch the marker on `pod stop`.
	const script = [
		"#!/bin/sh",
		`echo "$@" >> "${runpodctlLog}"`,
		`if [ "$1" = "pod" ] && [ "$2" = "stop" ]; then touch "${stopMarker}"; fi`,
		"exit 0",
		"",
	].join("\n");
	writeFileSync(path.join(tmp, "runpodctl"), script, { mode: 0o755 });
	chmodSync(path.join(tmp, "runpodctl"), 0o755);
	return { tmp, sentinelPath, stopMarker, runpodctlLog };
}

function spawnWatchdog(rig: WdRig, parentPid: number, podId: string): ChildProcess {
	writeFileSync(rig.sentinelPath, `${JSON.stringify({ parentPid, podId })}\n`);
	const wd = spawn(
		process.execPath,
		[WATCHDOG, String(parentPid), podId, rig.sentinelPath, INTERVAL_MS],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, PATH: `${rig.tmp}${path.delimiter}${process.env.PATH}` },
		},
	);
	// Debug aid: if the watchdog fails to boot, its stderr is the only clue.
	let stderr = "";
	wd.stderr!.on("data", (d) => {
		stderr += d;
		if (stderr.length < 4000) process.stderr.write(`[watchdog stderr] ${d}`);
	});
	return wd;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

const rigs: WdRig[] = [];
const procs: ChildProcess[] = [];

afterEach(() => {
	for (const p of procs.splice(0)) {
		if (p.exitCode === null) p.kill("SIGKILL");
	}
	for (const r of rigs.splice(0)) rmSync(r.tmp, { recursive: true, force: true });
});

describe("runpod watchdog", () => {
	it("stops the pod after the parent is kill -9'd, then removes the sentinel and exits", async () => {
		const rig = setup("pod-k9");
		rigs.push(rig);
		const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});
		procs.push(victim);
		const wd = spawnWatchdog(rig, victim.pid!, "pod-k9");
		procs.push(wd);

		victim.kill("SIGKILL");

		// The 60s bound in the driver is for the default 15s interval; at 50ms
		// this should land in well under 5s.
		expect(await waitFor(() => existsSync(rig.stopMarker), 5_000)).toBe(true);
		expect(await waitFor(() => !existsSync(rig.sentinelPath), 5_000)).toBe(true);
		expect(await waitFor(() => wd.exitCode !== null, 5_000)).toBe(true);
	}, 20_000);

	it("exits quietly on normal stop (sentinel deleted) without stopping the pod", async () => {
		const rig = setup("pod-normal");
		rigs.push(rig);
		// Parent is this very test process — alive for the whole test.
		const wd = spawnWatchdog(rig, process.pid, "pod-normal");
		procs.push(wd);

		await new Promise((r) => setTimeout(r, 150)); // a few ticks
		rmSync(rig.sentinelPath, { force: true });

		expect(await waitFor(() => wd.exitCode !== null, 5_000)).toBe(true);
		expect(existsSync(rig.stopMarker)).toBe(false);
	}, 20_000);

	it("never stops the pod while the parent is alive", async () => {
		const rig = setup("pod-alive");
		rigs.push(rig);
		const wd = spawnWatchdog(rig, process.pid, "pod-alive");
		procs.push(wd);

		await new Promise((r) => setTimeout(r, 300)); // several ticks
		expect(existsSync(rig.stopMarker)).toBe(false);
		expect(existsSync(rig.sentinelPath)).toBe(true);
		expect(wd.exitCode).toBeNull();
	}, 20_000);
});
