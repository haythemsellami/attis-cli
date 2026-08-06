/**
 * Audit helper library tests (real python3 sidecar, guarded).
 *
 * repo.* runs everywhere python3 exists. fork.verify + slither.scan run
 * only when the foundry/slither CLIs are on PATH (mirroring the guard
 * style of packages/fork/test/fork.test.ts).
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel, type Kernel } from "../src/kernel.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasFoundry =
	spawnSync("which", ["anvil"]).status === 0 && spawnSync("which", ["forge"]).status === 0;
const hasSlither = spawnSync("which", ["slither"]).status === 0;

const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "./Oracle.sol";
contract Vault { Oracle public oracle; }
`;

const ORACLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Oracle { function price() external view returns (uint256) { return 1; } }
`;

const POC_PASS = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
contract PocTest is Test {
    function test_always_passes() public {
        assertTrue(true);
    }
}
`;

describe.skipIf(!hasPython)("audit helpers (real python3)", () => {
	let repoDir: string;
	let scratchDir: string;
	let kernel: Kernel;

	beforeAll(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-helpers-repo-"));
		scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-helpers-scratch-"));
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "src", "Vault.sol"), VAULT);
		await fs.writeFile(path.join(repoDir, "src", "Oracle.sol"), ORACLE);
		await fs.writeFile(path.join(repoDir, "README.md"), "fixture repo\n");
		await fs.writeFile(path.join(path.dirname(repoDir), `outside-${path.basename(repoDir)}.txt`), "secret\n");
		kernel = await createKernel({ repoRoot: repoDir, scratchDir, timeoutMs: 60_000 });
	}, 30_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(repoDir, { recursive: true, force: true });
		await fs.rm(scratchDir, { recursive: true, force: true });
		await fs.rm(path.join(path.dirname(repoDir), `outside-${path.basename(repoDir)}.txt`), { force: true });
	});

	it("repo.tree() lists files and the solidity import graph", async () => {
		const r = await kernel.exec("repo.tree()");
		expect(r.ok).toBe(true);
		expect(r.result).toContain("src/Vault.sol");
		expect(r.result).toContain("README.md");
		// Vault imports ./Oracle.sol — the graph records it.
		expect(r.result).toContain("./Oracle.sol");
	});

	it("repo.read() returns file contents", async () => {
		const r = await kernel.exec("repo.read('README.md')");
		expect(r.ok).toBe(true);
		expect(r.result).toContain("fixture repo");
	});

	it("repo.read() rejects path traversal outside the repo root", async () => {
		const r = await kernel.exec(`repo.read('../outside-${path.basename(repoDir)}.txt')`);
		expect(r.ok).toBe(false);
		expect(r.error?.type).toBe("ValueError");
		expect(r.error?.message).toContain("escapes repo root");
		// Absolute paths outside the root are rejected too.
		const abs = await kernel.exec(`repo.read('/etc/passwd')`);
		expect(abs.ok).toBe(false);
		expect(abs.error?.type).toBe("ValueError");
	});

	it("slither.scan() degrades cleanly when slither is off PATH", async () => {
		// Simulate absence by shadowing shutil.which in the kernel namespace.
		const r = await kernel.exec(
			"import shutil\n" +
				"orig = shutil.which\n" +
				"shutil.which = lambda _: None\n" +
				"res = slither.scan()\n" +
				"shutil.which = orig\n" +
				"(res['ok'], res['error'][:30])",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toContain("False");
		expect(r.result).toContain("slither not found");
	});

	it.skipIf(!hasFoundry)("fork.create + snapshot/revert + fork.verify (real anvil + forge)", async () => {
		const create = await kernel.exec("fork.create()");
		expect(create.ok).toBe(true);
		expect(create.result).toContain("127.0.0.1");

		const snap = await kernel.exec("fork.snapshot()");
		expect(snap.ok).toBe(true);
		expect(snap.result).toContain("0x");

		const poc = JSON.stringify(POC_PASS);
		const verify = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(verify.ok).toBe(true);
		expect(verify.result).toContain("'verified'");
		expect(verify.result).toContain("raw_log_path");

		const revert = await kernel.exec(`fork.revert(${snap.result})`);
		expect(revert.ok).toBe(true);

		await kernel.exec("fork.stop_all()");
	}, 320_000);

	it.skipIf(!hasSlither)("slither.scan() returns a structured result (real slither)", async () => {
		// The scan may fail to compile without network (solc download) — the
		// contract under test is that scan() returns a structured {ok, ...}
		// dict either way instead of raising into the kernel.
		const r = await kernel.exec("slither.scan()", { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		expect(r.result).toMatch(/'ok': (True|False)/);
	}, 320_000);
});
