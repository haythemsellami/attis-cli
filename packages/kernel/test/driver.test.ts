/**
 * Executor driver tests: env scrubbing, LocalDriver session isolation,
 * DockerDriver stub. LocalDriver tests use a real python3 (guarded).
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DockerDriver,
	LocalDriver,
	NotImplementedError,
	scrubEnv,
} from "../src/driver.js";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("scrubEnv", () => {
	it("drops secret-bearing vars, keeps basics + RPC proxy vars", () => {
		const scrubbed = scrubEnv({
			PATH: "/usr/bin",
			HOME: "/home/u",
			AWS_SECRET_ACCESS_KEY: "aws",
			AWS_SESSION_TOKEN: "aws",
			GH_TOKEN: "gh",
			GITHUB_TOKEN: "gh",
			HF_TOKEN: "hf",
			OPENAI_API_KEY: "oai",
			ANTHROPIC_API_KEY: "ant",
			DEEPSEEK_API_KEY: "ds",
			ATTIS_API_KEY: "serving-key-must-not-leak",
			RPC_URL: "http://127.0.0.1:8555",
			ATTIS_RPC_PROXY: "http://127.0.0.1:8555",
			ETH_RPC_URL: "http://127.0.0.1:8555",
		});
		expect(scrubbed.PATH).toBe("/usr/bin");
		expect(scrubbed.HOME).toBe("/home/u");
		expect(scrubbed.RPC_URL).toBe("http://127.0.0.1:8555");
		expect(scrubbed.ATTIS_RPC_PROXY).toBe("http://127.0.0.1:8555");
		expect(scrubbed.ETH_RPC_URL).toBe("http://127.0.0.1:8555");
		for (const leaked of [
			"AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
			"HF_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY",
			"ATTIS_API_KEY",
		]) {
			expect(scrubbed[leaked]).toBeUndefined();
		}
	});
});

describe("DockerDriver (deferred stub)", () => {
	it("throws NotImplementedError naming the trigger conditions", async () => {
		const driver = new DockerDriver();
		await expect(driver.prepare({ id: "s", repoRoot: "/tmp/x" })).rejects.toThrow(NotImplementedError);
		await expect(driver.prepare({ id: "s", repoRoot: "/tmp/x" })).rejects.toThrow(
			/fleet scale.*untrusted.*hermetic eval/s,
		);
	});
});

describe.skipIf(!hasPython)("LocalDriver (real python3)", () => {
	it("prepares an isolated env: repo copy, scratch, scrubbed env; cleanup removes it", async () => {
		const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-driver-repo-"));
		await fs.writeFile(path.join(repoDir, "README.md"), "original\n");
		process.env.ATTIS_TEST_SECRET_LEAK = "should-not-leak";

		const driver = new LocalDriver({ timeoutMs: 30_000 });
		const env = await driver.prepare({ id: "test", repoRoot: repoDir });
		try {
			// Kernel runs against the copy, not the original.
			expect(env.repoCopy).not.toBe(repoDir);
			const read = await env.kernel.exec("repo.read('README.md')");
			expect(read.ok).toBe(true);
			expect(read.result).toContain("original");

			// Writes land in the copy only — originals never touched.
			const write = await env.kernel.exec(
				`import os\nopen(os.path.join(repo.CTX["repo_root"], "written.txt"), "w").write("x")`,
			);
			expect(write.ok).toBe(true);
			await expect(fs.access(path.join(repoDir, "written.txt"))).rejects.toThrow();
			await expect(fs.access(path.join(env.repoCopy, "written.txt"))).resolves.toBeUndefined();

			// The sidecar's env is scrubbed end-to-end.
			const leak = await env.kernel.exec(
				"import os; os.environ.get('ATTIS_TEST_SECRET_LEAK', 'ABSENT')",
			);
			expect(leak.result).toBe("'ABSENT'");
		} finally {
			const tmp = path.dirname(env.repoCopy);
			await env.cleanup();
			await expect(fs.access(tmp)).rejects.toThrow();
			await fs.rm(repoDir, { recursive: true, force: true });
			delete process.env.ATTIS_TEST_SECRET_LEAK;
		}
	}, 60_000);
});
