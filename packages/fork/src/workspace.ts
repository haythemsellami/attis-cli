/**
 * forge workspace materialization for PoC execution.
 *
 * A template workspace is created ONCE at ~/.attis/forge-template
 * (forge init + forge-std installed), then each PoC run copies it to a fresh
 * run dir and drops the PoC in as test/Poc.t.sol.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TEMPLATE_DIR = path.join(os.homedir(), ".attis", "forge-template");
const RUNS_DIR = path.join(os.homedir(), ".attis", "poc-runs");

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** Create the template workspace once (needs network only if forge-std missing). */
export async function ensureTemplate(): Promise<string> {
	const forgeStdTest = path.join(TEMPLATE_DIR, "lib", "forge-std", "src", "Test.sol");
	if (await exists(forgeStdTest)) {
		return TEMPLATE_DIR;
	}
	await fs.mkdir(TEMPLATE_DIR, { recursive: true });
	if (!(await exists(path.join(TEMPLATE_DIR, "foundry.toml")))) {
		await execFileP("forge", ["init", "--no-git", "--force", TEMPLATE_DIR]);
	}
	if (!(await exists(forgeStdTest))) {
		// Older forge: install forge-std explicitly. Modern forge init bundles it.
		try {
			await execFileP("forge", ["install", "foundry-rs/forge-std", "--no-git"], {
				cwd: TEMPLATE_DIR,
			});
		} catch (e) {
			// Race or pre-existing partial dir — accept if the file is now there.
			if (!(await exists(forgeStdTest))) throw e;
		}
	}
	return TEMPLATE_DIR;
}

/**
 * Materialize a run dir: copy of the template with the PoC as test/Poc.t.sol.
 * Returns the run dir path.
 */
export async function materializeRun(pocCode: string): Promise<string> {
	const template = await ensureTemplate();
	await fs.mkdir(RUNS_DIR, { recursive: true });
	const runDir = await fs.mkdtemp(path.join(RUNS_DIR, "run-"));
	await fs.cp(template, runDir, { recursive: true });
	await fs.writeFile(path.join(runDir, "test", "Poc.t.sol"), pocCode);
	return runDir;
}
