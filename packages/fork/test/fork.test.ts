/**
 * Fork layer end-to-end: real anvil + real forge (integration).
 * Requires foundry on PATH and network for the first forge-std install.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startAnvil, type AnvilHandle } from "../src/anvil.js";
import { runPocOnAnvil } from "../src/runner.js";

const POC_GOOD = readFileSync("examples/poc-reentrancy.sol", "utf-8");

const POC_BROKEN = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
contract PocTest is Test {
    function test_reverts() public {
        revert("nothing works here");
    }
}
`;

const POC_NOT_A_TEST = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Attack { function go() external {} }
`;

describe("fork layer (real anvil + forge)", () => {
	let anvil: AnvilHandle;

	it("starts an anvil (plain mode)", async () => {
		anvil = await startAnvil();
		expect(anvil.port).toBeGreaterThan(0);
	}, 40_000);

	it("correct PoC verifies on the vulnerable vault", async () => {
		const verdict = await runPocOnAnvil(anvil, POC_GOOD);
		expect(verdict.verified).toBe(true);
		expect(verdict.passed).toBe(true);
	}, 300_000);

	it("broken PoC returns verified=false with a trace", async () => {
		const verdict = await runPocOnAnvil(anvil, POC_BROKEN);
		expect(verdict.verified).toBe(false);
		expect(verdict.trace).toBeTruthy();
	}, 300_000);

	it("non-test PoC is flagged notATest", async () => {
		const verdict = await runPocOnAnvil(anvil, POC_NOT_A_TEST);
		expect(verdict.notATest).toBe(true);
		expect(verdict.verified).toBe(false);
	}, 60_000);

	it("kills anvil cleanly", async () => {
		await anvil.kill();
	}, 10_000);
});
