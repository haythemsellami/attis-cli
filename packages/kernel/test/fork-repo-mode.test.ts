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

// Era-pinned fixture (2021-2022 style): `=0.8.4` cannot compile against
// latest forge-std (requires >=0.8.13) — needs the legacy variant.
const LEGACY_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;
contract LegacyVault {
    mapping(address => uint256) public balances;
    function deposit() external payable { balances[msg.sender] += msg.value; }
    function total() external view returns (uint256) { return address(this).balance; }
}
`;

const POC_TEMPLATE_LEGACY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "repo/src/LegacyVault.sol";
contract PocTest is Test {
    LegacyVault vault;
    function setUp() public { vault = new LegacyVault(); }
    function test_deposit_lands() public {
        vm.deal(address(this), 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.total(), 1 ether);
    }
}
`;

// escher-style fixture: repo-mode (foundry.toml present), contracts import
// the upgradeable package by its lib/ path and no lib/ is vendored.
const FOUNDRY_TOML_UPGR = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
remappings = ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"]
`;

const UPGR_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "lib/openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";
contract UpgradeableVault is Initializable {
    uint256 public total;
    function initialize() public initializer { total = 0; }
    function deposit() external payable { total += msg.value; }
}
`;

const POC_REPO_UPGR = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "../../src/UpgradeableVault.sol";
contract PocTest is Test {
    UpgradeableVault vault;
    function setUp() public {
        vault = new UpgradeableVault();
        vault.initialize();
    }
    function test_deposit_lands() public {
        vm.deal(address(this), 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.total(), 1 ether);
    }
}
`;

// malt-style fixture (2021): unbounded low pragma + an OZ 3.x-only import
// path (contracts/math/SafeMath.sol — moved in 4.x, deleted in 5.x).
const MALT_VAULT = `// SPDX-License-Identifier: MIT
pragma solidity >=0.6.6;
import "@openzeppelin/contracts/math/SafeMath.sol";
contract MaltVault {
    using SafeMath for uint256;
    mapping(address => uint256) public balances;
    function deposit() external payable {
        balances[msg.sender] = balances[msg.sender].add(msg.value);
    }
    function totalOf(address who) external view returns (uint256) {
        return balances[who];
    }
}
`;

const POC_TEMPLATE_MALT = `// SPDX-License-Identifier: MIT
// Era-compatible pragma: a PoC importing pre-0.8 contracts must not pin
// ^0.8.x — the compile graph has to intersect with OZ v3's <0.8.0. On
// solc <0.8.0, inheriting forge-std's Test also needs abicoder v2.
pragma solidity >=0.6.6;
pragma abicoder v2;
import "forge-std/Test.sol";
import "repo/src/MaltVault.sol";
contract PocTest is Test {
    MaltVault vault;
    function setUp() public { vault = new MaltVault(); }
    function test_deposit_lands() public {
        vm.deal(address(this), 1 ether);
        vault.deposit{value: 1 ether}();
        assertEq(vault.totalOf(address(this)), 1 ether);
    }
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

	it("pragma_upper_bound parses every pragma style", async () => {
		const r = await kernel.exec(
			"(\n" +
				"    deps.pragma_upper_bound('pragma solidity =0.8.4;'),\n" +
				"    deps.pragma_upper_bound('pragma solidity >=0.8.0 <0.9.0;'),\n" +
				"    deps.pragma_upper_bound('pragma solidity ^0.8.0;'),\n" +
				"    deps.pragma_upper_bound('pragma solidity >=0.5.0;'),\n" +
				"    deps.pragma_upper_bound('pragma solidity 0.8.4;'),\n" +
				"    deps.pragma_upper_bound('pragma solidity <=0.8.12;'),\n" +
				"    deps.pragma_upper_bound('contract NoPragma {}'),\n" +
				")",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe(
			"(((0, 8, 4), True), ((0, 9, 0), False), ((0, 9, 0), False), None, " +
				"((0, 8, 4), True), ((0, 8, 12), True), None)",
		);
	});

	it("pick_forge_std picks the era from the repo's max satisfiable solc", async () => {
		// A path input: =0.8.4 pinned file on disk.
		const pinned = path.join(root, "era-pinned.sol");
		await fs.writeFile(pinned, "pragma solidity =0.8.4;\ncontract Pinned {}\n");
		const r = await kernel.exec(
			"(\n" +
				"    deps.pick_forge_std(['pragma solidity =0.8.4;\\ncontract V{}']),\n" +
				"    deps.pick_forge_std(['pragma solidity ^0.8.20;\\ncontract V{}']),\n" +
				"    deps.pick_forge_std(['pragma solidity ^0.8.0;', 'pragma solidity =0.8.4;']),\n" +
				"    deps.pick_forge_std(['pragma solidity >=0.8.0 <0.9.0;']),\n" +
				"    deps.pick_forge_std(['pragma solidity >=0.5.0;']),\n" +
				"    deps.pick_forge_std(['// no pragma at all']),\n" +
				"    deps.pick_forge_std([]),\n" +
				`    deps.pick_forge_std([${JSON.stringify(pinned)}]),\n` +
				")",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe(
			"('forge-std-legacy', 'forge-std', 'forge-std-legacy', 'forge-std', " +
				"'forge-std', 'forge-std', 'forge-std', 'forge-std-legacy')",
		);
	});

	it("registry addition is offline-graceful", async () => {
		const d = JSON.stringify(depsDir);
		const r = await kernel.exec(
			"def boom(args, **kw):\n    raise OSError('no network')\n" +
				`res = deps.ensure(names=["openzeppelin-contracts-upgradeable"], cache_dir=${d}, runner=boom)\n` +
				'res["openzeppelin-contracts-upgradeable"] is None',
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("True");
	});

	it("era-variant registry entries are offline-graceful", async () => {
		const d = JSON.stringify(depsDir);
		const r = await kernel.exec(
			"def boom(args, **kw):\n    raise OSError('no network')\n" +
				"res = deps.ensure(names=['openzeppelin-contracts-legacy', " +
				"'openzeppelin-contracts-v4', 'openzeppelin-contracts-upgradeable-legacy', " +
				`'openzeppelin-contracts-upgradeable-v4'], cache_dir=${d}, runner=boom)\n` +
				"all(v is None for v in res.values())",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("True");
	});

	it("pick_dep era table: OZ legacy/v4/latest, upgradeable mirrors, forge-std rule kept", async () => {
		const r = await kernel.exec(
			"def pick(name, srcs):\n" +
				"    lo, hi = deps.repo_solc_bounds(srcs)\n" +
				"    return deps.pick_dep(name, hi, lo)\n" +
				"(\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity =0.6.6;']),\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity >=0.6.6;']),\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity >=0.6.0 <0.8.0;']),\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity =0.8.4;']),\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity ^0.8.0;']),\n" +
				"    pick('openzeppelin-contracts', ['pragma solidity ^0.8.20;']),\n" +
				"    pick('openzeppelin-contracts', ['contract NoPragma {}']),\n" +
				"    pick('openzeppelin-contracts-upgradeable', ['pragma solidity >=0.6.6;']),\n" +
				"    pick('openzeppelin-contracts-upgradeable', ['pragma solidity =0.8.4;']),\n" +
				// Wiring passes both bounds: unbounded-but-old-minimum repos
				// need forge-std-legacy too (their graph can't mix in >=0.8.13).
				"    pick('forge-std', ['pragma solidity >=0.6.6;']),\n" +
				"    pick('solmate', ['pragma solidity =0.6.6;']),\n" +
				")",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe(
			"('openzeppelin-contracts-legacy', 'openzeppelin-contracts-legacy', " +
				"'openzeppelin-contracts-legacy', 'openzeppelin-contracts-v4', " +
				"'openzeppelin-contracts', 'openzeppelin-contracts', 'openzeppelin-contracts', " +
				"'openzeppelin-contracts-upgradeable-legacy', 'openzeppelin-contracts-upgradeable-v4', " +
				"'forge-std-legacy', 'solmate')",
		);
	});

	it("lib detection: remappings (both styles), import prefixes, upgradeable pairing", async () => {
		const r = await kernel.exec(
			"cases = [\n" +
				"    '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/',\n" +
				"    'openzeppelin-contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/',\n" +
				'    \'import "openzeppelin-contracts-upgradeable/contracts/proxy/utils/Initializable.sol";\',\n' +
				'    \'import "lib/openzeppelin-contracts-upgradeable/contracts/token/ERC20/ERC20Upgradeable.sol";\',\n' +
				'    \'import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";\',\n' +
				'    \'import "solmate/tokens/ERC20.sol";\',\n' +
				'    \'import "src/Vault.sol";\',\n' +
				"]\n" +
				"[sorted(fork._referenced_std_libs(c)) for c in cases]",
		);
		expect(r.ok).toBe(true);
		const both = "['openzeppelin-contracts', 'openzeppelin-contracts-upgradeable']";
		expect(r.result).toBe(
			`[['openzeppelin-contracts'], ${both}, ${both}, ${both}, ${both}, ` +
				"['solmate'], []]",
		);
	});

	it("repo-mode lib provisioning symlinks only absent dirs (hermetic cache)", async () => {
		// Fake the cache (no network): present dirs satisfy ensure().
		for (const name of ["openzeppelin-contracts", "openzeppelin-contracts-upgradeable"]) {
			await fs.mkdir(path.join(depsDir, name), { recursive: true });
			await fs.writeFile(path.join(depsDir, name, "placeholder"), "x");
		}
		// A foundry repo whose imports hit the upgradeable lib path; its
		// lib/forge-std is vendored (a real dir) and must be left alone.
		const proj = path.join(root, "prov-repo");
		await fs.mkdir(path.join(proj, "src"), { recursive: true });
		await fs.mkdir(path.join(proj, "lib", "forge-std"), { recursive: true });
		await fs.writeFile(path.join(proj, "lib", "forge-std", "vendored"), "x");
		await fs.writeFile(path.join(proj, "foundry.toml"), FOUNDRY_TOML_UPGR);
		await fs.writeFile(path.join(proj, "src", "UpgradeableVault.sol"), UPGR_VAULT);

		const r = await kernel.exec(
			`linked, _paths = fork._symlink_std_libs(${JSON.stringify(await fs.realpath(proj))}, "")\n` +
				"sorted(linked)",
		);
		expect(r.ok).toBe(true);
		expect(r.result).toBe("['openzeppelin-contracts', 'openzeppelin-contracts-upgradeable']");
		const upg = await fs.lstat(path.join(proj, "lib", "openzeppelin-contracts-upgradeable"));
		expect(upg.isSymbolicLink()).toBe(true);
		// Pairing: plain OZ is provisioned as the upgradeable sibling.
		const oz = await fs.lstat(path.join(proj, "lib", "openzeppelin-contracts"));
		expect(oz.isSymbolicLink()).toBe(true);
		// Vendored forge-std is untouched.
		const vendored = await fs.lstat(path.join(proj, "lib", "forge-std"));
		expect(vendored.isSymbolicLink()).toBe(false);
		await expect(fs.access(path.join(proj, "lib", "forge-std", "vendored"))).resolves.toBeUndefined();
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

describe.skipIf(!canIntegrate)("template-mode era selection (forge-std-legacy, real forge + clone)", () => {
	let root: string;
	let depsDir: string;
	let kernel: Kernel;
	let legacyReady = false;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-legacy-int-"));
		const repoDir = path.join(root, "repo");
		depsDir = path.join(root, "deps");
		// No foundry.toml — template mode. `=0.8.4` pins the whole compile
		// unit below latest forge-std's 0.8.13 floor.
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "src", "LegacyVault.sol"), LEGACY_VAULT);
		kernel = await makeKernel(
			repoDir,
			path.join(root, "scratch"),
			depsDir,
			path.join(root, "journal"),
		);
		const warm = await kernel.exec(
			'deps.ensure(["forge-std-legacy"])["forge-std-legacy"] is not None',
			{ timeoutMs: 300_000 },
		);
		legacyReady = warm.result === "True";
	}, 330_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("=0.8.4-pinned repo reaches a real verdict, not a pragma-conflict error", async (ctx) => {
		if (!legacyReady) ctx.skip();
		const poc = JSON.stringify(POC_TEMPLATE_LEGACY);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		const marker = parseMarker(r.stdout);
		expect(marker.mode).toBe("template");
		// The pre-fix failure was an "error" verdict from the pragma
		// conflict; a real verdict (verified or reverted) is the contract.
		expect(["verified", "reverted"]).toContain(marker.verdict);
		expect(r.result).toContain("'verified'");
		// The legacy variant really was provisioned in the deps cache.
		await expect(fs.access(path.join(depsDir, "forge-std-legacy"))).resolves.toBeUndefined();
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

describe.skipIf(!canIntegrate)("repo-mode lib provisioning (openzeppelin-upgradeable, real forge + clone)", () => {
	let root: string;
	let repoDir: string;
	let kernel: Kernel;
	let depsReady = false;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-upgr-int-"));
		repoDir = path.join(root, "repo");
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "foundry.toml"), FOUNDRY_TOML_UPGR);
		await fs.writeFile(path.join(repoDir, "src", "UpgradeableVault.sol"), UPGR_VAULT);
		kernel = await makeKernel(
			repoDir,
			path.join(root, "scratch"),
			path.join(root, "deps"),
			path.join(root, "journal"),
		);
		const warm = await kernel.exec(
			'res = deps.ensure(["openzeppelin-contracts-upgradeable", "openzeppelin-contracts", "forge-std"])\n' +
				"all(v is not None for v in res.values())",
			{ timeoutMs: 300_000 },
		);
		depsReady = warm.result === "True";
	}, 330_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("lib/-path imports of the upgradeable package reach a real verdict (mode=repo)", async (ctx) => {
		if (!depsReady) ctx.skip();
		const poc = JSON.stringify(POC_REPO_UPGR);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		const marker = parseMarker(r.stdout);
		expect(marker.mode).toBe("repo");
		expect(["verified", "reverted"]).toContain(marker.verdict);
		expect(r.result).toContain("'verified'");

		// All three libs were symlinked from the cache into the repo copy.
		for (const name of ["forge-std", "openzeppelin-contracts", "openzeppelin-contracts-upgradeable"]) {
			const stat = await fs.lstat(path.join(repoDir, "lib", name));
			expect(stat.isSymbolicLink()).toBe(true);
		}
		// The PoC dir is cleaned up after the run.
		await expect(fs.access(path.join(repoDir, "test", "attis_poc"))).rejects.toThrow();
	}, 320_000);
});

describe.skipIf(!canIntegrate)("template-mode OZ era selection (v3 legacy, real forge + clone)", () => {
	let root: string;
	let depsDir: string;
	let kernel: Kernel;
	let legacyReady = false;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "attis-malt-int-"));
		const repoDir = path.join(root, "repo");
		depsDir = path.join(root, "deps");
		// No foundry.toml — template mode. `>=0.6.6` + the v3-only
		// math/SafeMath.sol import path: only OZ 3.4.2 satisfies this.
		await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
		await fs.writeFile(path.join(repoDir, "src", "MaltVault.sol"), MALT_VAULT);
		kernel = await makeKernel(
			repoDir,
			path.join(root, "scratch"),
			depsDir,
			path.join(root, "journal"),
		);
		const warm = await kernel.exec(
			'deps.ensure(["openzeppelin-contracts-legacy"])["openzeppelin-contracts-legacy"] is not None',
			{ timeoutMs: 300_000 },
		);
		legacyReady = warm.result === "True";
	}, 330_000);

	afterAll(async () => {
		await kernel.stop();
		await fs.rm(root, { recursive: true, force: true });
	});

	it(">=0.6.6 repo importing @openzeppelin/contracts/math/SafeMath.sol reaches a real verdict", async (ctx) => {
		if (!legacyReady) ctx.skip();
		const poc = JSON.stringify(POC_TEMPLATE_MALT);
		const r = await kernel.exec(`fork.verify(${poc})`, { timeoutMs: 300_000 });
		expect(r.ok).toBe(true);
		const marker = parseMarker(r.stdout);
		expect(marker.mode).toBe("template");
		// The pre-fix failure was an "error" verdict (No such file or
		// directory for math/SafeMath.sol on OZ 5.x); a real verdict is
		// the contract.
		expect(["verified", "reverted"]).toContain(marker.verdict);
		expect(r.result).toContain("'verified'");
		await expect(fs.access(path.join(depsDir, "openzeppelin-contracts-legacy"))).resolves.toBeUndefined();
	}, 320_000);
});
