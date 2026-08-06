/**
 * runpod watchdog — the kill -9 guarantee (roadmap item 4 acceptance).
 *
 * Spawned DETACHED by the runpod driver with the parent CLI's pid, the pod
 * id, and the sentinel file path. While the parent lives, it ticks quietly.
 * When the parent pid is gone (crash, kill -9 — anything), it stops the pod
 * (the golden rule: a running pod bills per second), removes the sentinel,
 * and exits. A normal stop() deletes the sentinel and kills this process,
 * so a clean exit never stops the pod twice.
 *
 * Constraints by design:
 * - standalone: node builtins only, no project imports
 * - quiet: no output ever (spawned with stdio "ignore" anyway)
 * - self-terminating: every path ends in exit()
 * - erasable TS syntax only (run directly by `node` >= 22.6 type-stripping)
 *
 * argv: <parentPid> <podId> <sentinelPath> [intervalMs=15000]
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

interface Sentinel {
	parentPid?: number;
	podId?: string;
}

const [parentPidArg, podId, sentinelPath, intervalArg] = process.argv.slice(2);
const parentPid = Number(parentPidArg);
const intervalMs = Number(intervalArg ?? 15_000) || 15_000;
if (!parentPid || !podId || !sentinelPath) process.exit(2);

function parentAlive(): boolean {
	try {
		process.kill(parentPid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is not ours to signal.
		return (err as { code?: string }).code === "EPERM";
	}
}

/** undefined = unreadable this tick (deleted or mid-rewrite); object = parsed. */
function readSentinel(): Sentinel | undefined {
	try {
		return JSON.parse(readFileSync(sentinelPath, "utf-8")) as Sentinel;
	} catch {
		return undefined;
	}
}

function stopPod(): Promise<boolean> {
	return new Promise((resolve) => {
		// Bounded: a hung runpodctl must not stall the retry loop past the 60s
		// guarantee (15s detect + 3 × (8s attempt + 5s pause) ≈ 54s).
		execFile("runpodctl", ["pod", "stop", podId!], { timeout: 8_000 }, (err) => resolve(!err));
	});
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let inTick = false;
async function tick(): Promise<void> {
	if (inTick) return;
	inTick = true;
	try {
		if (!existsSync(sentinelPath)) process.exit(0); // normal stop() cleaned up
		const sentinel = readSentinel();
		if (sentinel === undefined) return; // transient read race — look again next tick
		if (sentinel.podId !== podId || sentinel.parentPid !== parentPid) {
			process.exit(0); // superseded by a newer session — never stop its pod
		}
		if (parentAlive()) return;
		// Parent is gone. Stop the pod, then die. Budget: detection (one
		// interval) + 3 attempts keeps the pod alive < 60s after parent death.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (await stopPod()) break;
			await pause(5_000);
		}
		rmSync(sentinelPath, { force: true });
		process.exit(0);
	} finally {
		inTick = false;
	}
}

setInterval(() => {
	void tick();
}, intervalMs);
