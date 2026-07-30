/**
 * fork_verify runner — materialize a PoC workspace, run forge test against
 * an anvil instance, return a structured verdict.
 *
 * v1 semantics (roadmap): verified = the PoC's forge test PASSES on the
 * chain. Failures return the revert trace as the retry constraint (spec §5).
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AnvilHandle } from "./anvil.js";
import { materializeRun } from "./workspace.js";

const execFileP = promisify(execFile);

export interface ForkVerdict {
	verified: boolean;
	/** forge test passed on-chain. */
	passed: boolean;
	/** Revert reason / failure trace when the PoC failed (retry constraint). */
	trace?: string;
	/** PoC had no `function test` — not a forge test contract. */
	notATest?: boolean;
	/** Raw forge output (tail) for the journal. */
	forgeOutputTail: string;
}

const TEST_FN_RE = /function\s+test\w*\s*\(/;

export async function runPocOnAnvil(
	anvil: AnvilHandle,
	pocCode: string,
	opts: { timeoutMs?: number } = {},
): Promise<ForkVerdict> {
	if (!TEST_FN_RE.test(pocCode)) {
		return {
			verified: false,
			passed: false,
			notATest: true,
			trace: "PoC contains no `function test...()` — not a forge test contract",
			forgeOutputTail: "",
		};
	}

	const runDir = await materializeRun(pocCode);
	let stdout = "";
	let stderr = "";
	try {
		const result = await execFileP(
			"forge",
			["test", "--match-path", "test/Poc.t.sol", "-vvv", "--rpc-url", `http://127.0.0.1:${anvil.port}`],
			{ cwd: runDir, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 32 * 1024 * 1024 },
		);
		stdout = result.stdout;
		stderr = result.stderr;
	} catch (err) {
		// forge exits non-zero on test failure — output is in the error object.
		const e = err as { stdout?: string; stderr?: string };
		stdout = e.stdout ?? "";
		stderr = e.stderr ?? "";
	}

	const tail = (stdout + "\n" + stderr).trim().split("\n").slice(-40).join("\n");
	const passed = /\[PASS\]/.test(stdout) && !/\[FAIL/.test(stdout);
	let trace: string | undefined;
	if (!passed) {
		const reason = /(\[FAIL[.\]]*:?[^\n]*(?:\n(?!Ran|Suite)[^\n]*){0,6})/.exec(stdout);
		trace = (reason ? reason[1] : tail).slice(0, 2000);
	}

	// Clean up the run dir but keep the output in the verdict.
	await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});

	return { verified: passed, passed, trace: passed ? undefined : trace, forgeOutputTail: tail };
}

export { startAnvil } from "./anvil.js";
export type { AnvilHandle, AnvilOptions } from "./anvil.js";
