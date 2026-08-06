/**
 * Kernel sidecar protocol tests — real python3 subprocess (guarded).
 * Covers: round-trip, namespace persistence, error survival, timeout kill,
 * crash detection + one automatic restart with a fresh namespace.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel, type Kernel } from "../src/kernel.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("kernel sidecar (real python3)", () => {
	let dir: string;
	let kernel: Kernel;
	const restarts: { reason: string; restartCount: number }[] = [];

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-kernel-test-"));
		kernel = await createKernel({
			repoRoot: dir,
			scratchDir: path.join(dir, "scratch"),
			timeoutMs: 30_000,
			onRestart: (info) => {
				restarts.push(info);
			},
		});
	}, 30_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("round-trips a simple expression (result = repr of last expr)", async () => {
		const r = await kernel.exec("1 + 1");
		expect(r.ok).toBe(true);
		expect(r.result).toBe("2");
		expect(r.error).toBeNull();
	});

	it("captures stdout from user code", async () => {
		const r = await kernel.exec("print('hello kernel')");
		expect(r.ok).toBe(true);
		expect(r.stdout).toContain("hello kernel");
	});

	it("persists the namespace across calls", async () => {
		await kernel.exec("x = 41");
		const r = await kernel.exec("x + 1");
		expect(r.ok).toBe(true);
		expect(r.result).toBe("42");
	});

	it("survives exceptions — namespace intact after an error", async () => {
		const bad = await kernel.exec("1 / 0");
		expect(bad.ok).toBe(false);
		expect(bad.error?.type).toBe("ZeroDivisionError");
		expect(bad.error?.traceback).toContain("ZeroDivisionError");
		const good = await kernel.exec("x + 1");
		expect(good.ok).toBe(true);
		expect(good.result).toBe("42");
	});

	it("survives syntax errors too", async () => {
		const bad = await kernel.exec("def broken(:\n");
		expect(bad.ok).toBe(false);
		expect(bad.error?.type).toBe("SyntaxError");
		const good = await kernel.exec("'alive'");
		expect(good.ok).toBe(true);
	});

	it("kills runaway code at the timeout (signal.alarm)", async () => {
		const r = await kernel.exec("import time; time.sleep(30)", { timeoutMs: 1000 });
		expect(r.ok).toBe(false);
		expect(r.error?.type).toBe("TimeoutError");
		expect(r.durationMs).toBeLessThan(15_000);
		// Kernel is still usable afterwards.
		const after = await kernel.exec("x + 1");
		expect(after.ok).toBe(true);
		expect(after.result).toBe("42");
	}, 20_000);

	it("chdirs into the scratch dir at boot", async () => {
		const r = await kernel.exec("import os; os.getcwd()");
		expect(r.ok).toBe(true);
		expect(r.result).toContain("scratch");
	});

	it("restarts once after a crash, with a fresh namespace (journaled via onRestart)", async () => {
		const crashed = await kernel.exec("import os; os._exit(1)");
		expect(crashed.ok).toBe(false);
		expect(crashed.error?.type).toBe("KernelCrash");

		// Next exec transparently boots a fresh sidecar — and `x` is gone.
		const fresh = await kernel.exec("1 + 1");
		expect(fresh.ok).toBe(true);
		expect(fresh.restarted).toBe(true);
		const gone = await kernel.exec("x");
		expect(gone.ok).toBe(false);
		expect(gone.error?.type).toBe("NameError");

		expect(restarts.length).toBe(1);
		expect(restarts[0].restartCount).toBe(1);
		expect(kernel.restartCount).toBe(1);
	}, 30_000);

	it("stop() is clean and idempotent", async () => {
		await kernel.stop();
		await kernel.stop();
		const r = kernel.exec("1 + 1");
		await expect(r).rejects.toThrow("stopped");
	});
});
