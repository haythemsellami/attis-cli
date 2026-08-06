/**
 * Repo-aware fork.verify tests (real python3 sidecar, guarded).
 *
 * deps-cache + foundry-root detection units run everywhere python3 exists
 * (git is stubbed via an injected runner). Repo-mode / template-mode /
 * log-durability tests are integration-guarded: they need forge on PATH
 * plus git + network for the first deps-cache clone (mirroring the guard
 * style of helpers.test.ts and packages/fork/test/fork.test.ts).
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalDriver } from "../src/driver.js";
import { createKernel, type Kernel } from "../src/kernel.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const hasForge = spawnSync("which", ["forge"]).status === 0;
const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasNetwork =
	hasGit &&
	spawnSync("git", ["ls-remote", "https://github.com/foundry-rs/forge-std", "HEAD"], {
		timeout: 20_000,
	}).status === 0;
const canIntegrate = hasPython && hasForge && hasNetwork;

const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Vault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function total() external view returns (uint256) { return address(this).balance; }
}
`;

const FOUNDRY_TOML = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
`;

const OZ_TOKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract AuditToken is ERC20 {
    constructor() ERC20("AuditToken", "ATK") { _mint(msg.sender, 1000 ether); }
}
`;

const POC_REPO_MODE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "../../src/Vault.sol";
contract PocTest is Test {
    Vault vault;
    function setUp() public { vault = new Vault(); }
    function test_deposit_lands() public {
        vm.deal(address(this), 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.total(), 1 ether);
    }
}
`;

const POC_TEMPLATE_OZ = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Test.sol";
import "repo/src/AuditToken.sol";
contract PocTest is Test {
    AuditToken token;
    function setUp() public { token = new AuditToken(); }
    function test_supply() public view { assertEq(token.totalSupply(), 1000 ether); }
}
`;

const POC_TEMPLATE_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "repo/src/Vault.sol";
contract PocTest is Test {
    Vault vault;
    function setUp() public { vault = new Vault(); }
    function test_deposit_lands() public {
        vm.deal(address(this), 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.total(), 1 ether);
    }
}
`;

const POC_MISSING_IMPORT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "nonexistent/Thing.sol";
contract PocTest is Test {
    function test_never_compiles() public { assertTrue(true); }
}
`;

interface Marker {
	verdict?: string;
	raw_log_path?: string | null;
	mode?: string | null;
}

function parseMarker(stdout: string): Marker {
	const line = stdout.split("\n").find((l) => l.startsWith("ATTIS_FORK_VERDICT "));
	if (!line) throw new Error(`no ATTIS_FORK_VERDICT marker in stdout: ${stdout.slice(0, 400)}`);
	return JSON.parse(line.slice("ATTIS_FORK_VERDICT ".length)) as Marker;
}

async function makeKernel(repoRoot: string, scratchDir: string, depsDir: string, journalDir: string) {
	return createKernel({
		repoRoot,
		scratchDir,
		timeoutMs: 300_000,
		env: {
			...process.env,
			ATTIS_DEPS_DIR: depsDir,
			ATTIS_JOURNAL_DIR: journalDir,
		},
	});
}

describe.skipIf(!hasPython)("deps cache + foundry-root detection (real python3)", () => {
	let root: string;
	let repoDir: string;
	let scratchDir: string;
	let depsDir: string;
	let journalDir: string;
	let kernel: Kernel;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-repomode-unit-"));
		repoDir = path.join(root, "repo");
		scratchDir = path.join(root, "scratch");
		depsDir = path.join(root, "deps");
		journalDir = path.join(root, "journal");
		await fs.mkdir(repoDir, { recursive: true });
		kernel = await makeKernel(repoDir, scratchDir, depsDir, journalDir);
	}, 30_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("deps.ensure() clones absent deps once and reuses the cache (injected runner)", async () => {
		const d = JSON.stringify(depsDir);
		const r = await kernel.exec(
			"import os\n" +
				"calls = []\n" +
				"def fake_runner(args, **kw):\n" +
				"    calls.append(list(args))\n" +
				"    os.makedirs(args[-1], exist_ok=True)\n" +
				"    open(os.path.join(args[-1], 'placeholder'), 'w').write('x')\n" +
				"    class R: returncode = 0\n" +
				"    return R()\n" +
				`first = deps.ensure(names=["forge-std", "solmate"], cache_dir=${d}, runner=fake_runner)\n` +
				`second = deps.ensure(names=["forge-std", "solmate"], cache_dir=${d}, runner=fake_runner)\n` +
				"(len(calls), all(v is not None for v in first.values()), " +
				"all(v is not None for v in second.values()))",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("(2, True, True)");
		await expect(fs.access(path.join(depsDir, "forge-std"))).resolves.toBeUndefined();
		await expect(fs.access(path.join(depsDir, "solmate"))).resolves.toBeUndefined();
	});

	it("deps.ensure() is offline-graceful: failed clones report None, never raise", async () => {
		const d = JSON.stringify(depsDir);
		const r = await kernel.exec(
			"def boom(args, **kw):\n    raise OSError('no network')\n" +
				`res = deps.ensure(names=["solady"], cache_dir=${d}, runner=boom)\n` +
				`import os\n(res["solady"], os.path.isdir(os.path.join(${d}, "solady")))`,
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("(None, False)");
	});

	it("deps.ensure() rejects unknown dep names", async () => {
		const d = JSON.stringify(depsDir);
		const r = await kernel.exec(
			"try:\n" +
				`    deps.ensure(names=["nope"], cache_dir=${d})\n` +
				"    out = 'no-raise'\n" +
				"except ValueError:\n" +
				"    out = 'ValueError'\n" +
				"out",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("'ValueError'");
	});

	it("find_foundry_root: root-level foundry.toml wins", async () => {
		const dir = path.join(root, "ffr-root");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "foundry.toml"), FOUNDRY_TOML);
		const r = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(dir)})`);
		expect(r.ok).toBe(true);
		expect(r.result).toBe(`'${await fs.realpath(dir)}'`);
	});

	it("find_foundry_root: nested <=2 levels is found, deeper is not", async () => {
		const nested = path.join(root, "ffr-nested", "packages", "core");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(path.join(nested, "foundry.toml"), FOUNDRY_TOML);
		const r = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(path.join(root, "ffr-nested"))})`);
		expect(r.ok).toBe(true);
		expect(r.result).toBe(`'${await fs.realpath(nested)}'`);

		const deep = path.join(root, "ffr-deep", "a", "b", "c");
		await fs.mkdir(deep, { recursive: true });
		await fs.writeFile(path.join(deep, "foundry.toml"), FOUNDRY_TOML);
		const rDeep = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(path.join(root, "ffr-deep"))})`);
		expect(rDeep.ok).toBe(true);
		expect(rDeep.result).toBeNull(); // None — too deep to count
	});

	it("find_foundry_root: prefers shallowest, then most .sol files", async () => {
		const shallow = path.join(root, "ffr-shallow");
		await fs.mkdir(path.join(shallow, "sub"), { recursive: true });
		await fs.writeFile(path.join(shallow, "foundry.toml"), FOUNDRY_TOML);
		await fs.writeFile(path.join(shallow, "sub", "foundry.toml"), FOUNDRY_TOML);
		const r = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(shallow)})`);
		expect(r.result).toBe(`'${await fs.realpath(shallow)}'`);

		const tie = path.join(root, "ffr-tie");
		await fs.mkdir(path.join(tie, "x", "src"), { recursive: true });
		await fs.mkdir(path.join(tie, "y", "src"), { recursive: true });
		await fs.writeFile(path.join(tie, "x", "foundry.toml"), FOUNDRY_TOML);
		await fs.writeFile(path.join(tie, "x", "src", "One.sol"), "contract One {}\n");
		await fs.writeFile(path.join(tie, "y", "foundry.toml"), FOUNDRY_TOML);
		for (const n of ["A", "B", "C"]) {
			await fs.writeFile(path.join(tie, "y", "src", `${n}.sol`), `contract ${n} {}\n`);
		}
		const rTie = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(tie)})`);
		expect(rTie.result).toBe(`'${await fs.realpath(path.join(tie, "y"))}'`);
	});

	it("find_foundry_root: returns None for foundry-less repos", async () => {
		const dir = path.join(root, "ffr-none");
		await fs.mkdir(path.join(dir, "contracts"), { recursive: true });
		await fs.writeFile(path.join(dir, "contracts", "Token.sol"), "contract Token {}\n");
		const r = await kernel.exec(`fork.find_foundry_root(${JSON.stringify(dir)})`);
		expect(r.ok).toBe(true);
		expect(r.result).toBeNull(); // None — no foundry project in the repo
	});

	it("foundry_root override is confined to the repo copy", async () => {
		const poc = JSON.stringify(POC_TEMPLATE_VAULT);
		const escape = await kernel.exec(`fork.verify(${poc}, {"foundry_root": "../outside"})`);
		expect(escape.ok).toBe(false);
		expect(escape.error?.type).toBe("ValueError");
		expect(escape.error?.message).toContain("escapes repo root");

		const missing = await kernel.exec(`fork.verify(${poc}, {"foundry_root": "nope"})`);
		expect(missing.ok).toBe(false);
		expect(missing.error?.type).toBe("ValueError");
		expect(missing.error?.message).toContain("not a directory");
	});
});

describe.skipIf(!canIntegrate)("repo-mode fork.verify (real forge + deps clone)", () => {
	let root: string;
	let repoDir: string;
	let kernel: Kernel;
	let forgeStdReady = false;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-repomode-int-"));
		repoDir = path.join(root, "repo");
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "foundry.toml"), FOUNDRY_TOML);
		await fs.writeFile(path.join(repoDir, "src", "Vault.sol"), VAULT);
		kernel = await makeKernel(
			repoDir,
			path.join(root, "scratch"),
			path.join(root, "deps"),
			path.join(root, "journal"),
		);
		// Warm the deps cache; when the network is flaky mid-run the test
		// skips instead of failing (clone failure is exercised as a unit).
		const warm = await kernel.exec('deps.ensure(["forge-std"])["forge-std"] is not None', {
			timeoutMs: 300_000,
		});
		forgeStdReady = warm.result === "True";
	}, 330_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("verifies a PoC inside the repo copy: symlinked forge-std, mode=repo, durable log", async (ctx) => {
		if (!forgeStdReady) ctx.skip();
		const poc = JSON.stringify(POC_REPO_MODE);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		expect(r.result).toContain("'verified'");
		expect(r.result).toContain("'mode': 'repo'");

		const marker = parseMarker(r.stdout);
		expect(marker.mode).toBe("repo");
		expect(marker.verdict).toBe("verified");
		expect(marker.raw_log_path).toContain(path.join(root, "journal"));

		// forge-std was symlinked from the deps cache into the copy's lib/.
		const stat = await fs.lstat(path.join(repoDir, "lib", "forge-std"));
		expect(stat.isSymbolicLink()).toBe(true);
		// The PoC dir is cleaned up after the run.
		await expect(fs.access(path.join(repoDir, "test", "attis_poc"))).rejects.toThrow();
	}, 320_000);
});

describe.skipIf(!canIntegrate)("template-mode fork.verify with repo sources staged", () => {
	let root: string;
	let repoDir: string;
	let kernel: Kernel;
	let ozReady = false;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-template-int-"));
		repoDir = path.join(root, "repo");
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "src", "AuditToken.sol"), OZ_TOKEN);
		await fs.writeFile(path.join(repoDir, "src", "Vault.sol"), VAULT);
		kernel = await makeKernel(
			repoDir,
			path.join(root, "scratch"),
			path.join(root, "deps"),
			path.join(root, "journal"),
		);
		const warm = await kernel.exec(
			'deps.ensure(["openzeppelin-contracts"])["openzeppelin-contracts"] is not None',
			{ timeoutMs: 300_000 },
		);
		ozReady = warm.result === "True";
	}, 330_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("repo importing @openzeppelin gets a verdict, not a bare error (mode=template)", async (ctx) => {
		if (!ozReady) ctx.skip();
		const poc = JSON.stringify(POC_TEMPLATE_OZ);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		expect(r.result).toContain("'verified'");
		const marker = parseMarker(r.stdout);
		expect(marker.mode).toBe("template");
		expect(marker.verdict).toBe("verified");
	}, 320_000);

	it("error verdicts carry the first missing-import hint", async () => {
		const poc = JSON.stringify(POC_MISSING_IMPORT);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		expect(r.result).toContain("'error'");
		expect(r.result).toContain("missing_import");
		expect(r.result).toContain("nonexistent/Thing.sol");
	}, 320_000);
});

describe.skipIf(!canIntegrate)("log durability across ExecEnv.cleanup (LocalDriver)", () => {
	it("raw_log_path points at the journal dir and survives scratch cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-durable-"));
		const repoDir = path.join(root, "repo");
		const journalDir = path.join(root, "journal");
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "src", "Vault.sol"), VAULT);

		const driver = new LocalDriver({ timeoutMs: 300_000 });
		const env = await driver.prepare({ id: "durable", repoRoot: repoDir, journalDir });
		const scratchDir = env.scratchDir;
		try {
			const poc = JSON.stringify(POC_TEMPLATE_VAULT);
			const r = await env.kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
			expect(r.ok).toBe(true);
			expect(r.result).toContain("'verified'");
			const marker = parseMarker(r.stdout);
			expect(marker.mode).toBe("template");
			expect(marker.raw_log_path).toContain(journalDir);

			await env.cleanup();
			// Scratch is gone; the durable copy is not.
			await expect(fs.access(scratchDir)).rejects.toThrow();
			const log = await fs.readFile(marker.raw_log_path!, "utf-8");
			expect(log).toContain("Suite result");
		} finally {
			await env.cleanup().catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 320_000);
});
