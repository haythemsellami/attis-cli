/**
 * Rollout mode tests (roadmap v2 item 3) — no real model, no anvil, no
 * python: the agent is a fake (canned replies), the kernel comes from a
 * stub ExecutorDriver (same DI the execute_code tool tests use), and the
 * journal is an in-memory capture. Fixture repos are tiny temp dirs with a
 * .sol file each.
 *
 * Covers: manifest lifecycle (pending→done, resume skips done, --force
 * re-runs, interrupted→pending), failure containment, teacher config
 * selection, journal creation per repo, repo discovery, CLI arg parsing.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ExecutorDriver, Kernel } from "@attis/kernel";
import { loadPolicy } from "@attis/kernel";
import type { Journal } from "@attis/journal";
import {
	discoverRepos,
	parseRolloutArgs,
	runRollout,
	teacherServingConfig,
	type RepoInventory,
	type RolloutAgentContext,
	type RolloutManifest,
	type RolloutOptions,
} from "../src/rollout.js";

const SAFE_REPLY =
	"I reviewed the contracts with the kernel. No vulnerabilities found — the code is safe.";

const INVENTORY: RepoInventory = {
	files: ["src/Vault.sol"],
	imports: { "src/Vault.sol": ["./IOracle.sol"] },
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function stubKernel(inventory: RepoInventory = INVENTORY): Kernel {
	return {
		exec: async (code: string) => ({
			ok: true,
			stdout: code.includes("repo.tree()") ? JSON.stringify(inventory) : "",
			stderr: "",
			result: null,
			error: null,
			restarted: false,
			durationMs: 1,
		}),
		stop: async () => {},
		pid: 4321,
		restartCount: 0,
	};
}

function stubDriver(opts: { failFor?: string } = {}) {
	const prepared: string[] = [];
	const cleaned: string[] = [];
	const driver: ExecutorDriver = {
		prepare: async (session) => {
			if (opts.failFor && session.repoRoot.endsWith(opts.failFor)) {
				throw new Error("kernel boom");
			}
			prepared.push(session.repoRoot);
			return {
				kernel: stubKernel(),
				scratchDir: session.repoRoot,
				repoCopy: session.repoRoot,
				cleanup: async () => {
					cleaned.push(session.repoRoot);
				},
			};
		},
	};
	return { driver, prepared, cleaned };
}

/** Minimal Agent stand-in: runAuditLoop only needs prompt/waitForIdle/state. */
function fakeAgent(reply: string, prompts?: string[], emitOnPrompt?: unknown[]): Agent {
	const state = { messages: [] as unknown[] };
	let listener: ((event: unknown) => void) | undefined;
	return {
		state,
		prompt: async (text: string) => {
			prompts?.push(text);
			state.messages.push({ role: "user", content: [{ type: "text", text }] });
			for (const event of emitOnPrompt ?? []) listener?.(event);
			state.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
		},
		waitForIdle: async () => {},
		subscribe: (cb: (event: unknown) => void) => {
			listener = cb;
		},
	} as unknown as Agent;
}

/** The pi runtime reports endpoint failures as an error-stop assistant message. */
function endpointErrorEvent(errorMessage: string) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage,
		},
	};
}

interface JournalRec {
	writes: { type: string; data: Record<string, unknown> }[];
	closed: Record<string, unknown>[];
}

function fakeJournals() {
	const opened: string[] = [];
	const byRepo = new Map<string, JournalRec>();
	const journalFor = async (repoPath: string): Promise<Journal> => {
		opened.push(repoPath);
		const rec: JournalRec = { writes: [], closed: [] };
		byRepo.set(repoPath, rec);
		return {
			session: { id: `sess-${path.basename(repoPath)}`, dir: "", eventsPath: "" },
			write: async (type: string, data: Record<string, unknown>) => {
				rec.writes.push({ type, data });
			},
			close: async (summary?: Record<string, unknown>) => {
				rec.closed.push(summary ?? {});
			},
		} as unknown as Journal;
	};
	return { journalFor, opened, byRepo };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

afterEach(async () => {
	while (tmpRoots.length) {
		await fs.rm(tmpRoots.pop()!, { recursive: true, force: true }).catch(() => {});
	}
});

async function tmpRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attis-rollout-test-"));
	tmpRoots.push(dir);
	return dir;
}

async function makeRepo(parent: string, name: string): Promise<string> {
	const dir = path.join(parent, name);
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	// foundry.toml marks the dir as a repo in its own right (discoverRepos).
	await fs.writeFile(path.join(dir, "foundry.toml"), "[profile.default]\n");
	await fs.writeFile(
		path.join(dir, "src", "Vault.sol"),
		"// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Vault {}\n",
	);
	return dir;
}

async function readManifest(root: string): Promise<RolloutManifest> {
	return JSON.parse(
		await fs.readFile(path.join(root, ".attis-rollout.json"), "utf-8"),
	) as RolloutManifest;
}

function baseOpts(root: string, extra: Partial<RolloutOptions> = {}): RolloutOptions {
	return {
		rootDir: root,
		policy: loadPolicy("policy/execpolicy.json"),
		driver: stubDriver().driver,
		createAgent: () => fakeAgent(SAFE_REPLY),
		journalFor: fakeJournals().journalFor,
		...extra,
	};
}

// ---------------------------------------------------------------------------
// Manifest lifecycle
// ---------------------------------------------------------------------------

describe("runRollout — manifest lifecycle", () => {
	it("audits every repo to done and records the manifest", async () => {
		const root = await tmpRoot();
		const a = await makeRepo(root, "repo-a");
		const b = await makeRepo(root, "repo-b");
		const driver = stubDriver();
		const journals = fakeJournals();
		const events: Record<string, unknown>[] = [];

		const summary = await runRollout(
			baseOpts(root, {
				driver: driver.driver,
				journalFor: journals.journalFor,
				onEvent: (e) => events.push(e),
			}),
		);

		expect(summary.total).toBe(2);
		expect(summary.done).toBe(2);
		expect(summary.failed).toBe(0);
		expect(summary.skipped).toBe(0);
		expect(summary.manifestPath).toBe(path.join(root, ".attis-rollout.json"));

		const manifest = await readManifest(root);
		expect(manifest.version).toBe(1);
		expect(manifest.repos["repo-a"].status).toBe("done");
		expect(manifest.repos["repo-a"].sessionId).toBe("sess-repo-a");
		expect(manifest.repos["repo-a"].verified).toBe(0);
		expect(manifest.repos["repo-b"].status).toBe("done");

		// Cleanup ran for both kernel sessions.
		expect(driver.cleaned).toEqual([a, b]);

		// Wire events: start, per-repo start/done, end.
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("rollout_start");
		expect(types).toContain("repo_start");
		expect(types).toContain("repo_done");
		expect(types.at(-1)).toBe("rollout_done");
	});

	it("injects the repo.tree() inventory into the audit prompt", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		const prompts: string[] = [];
		const journals = fakeJournals();

		await runRollout(
			baseOpts(root, {
				journalFor: journals.journalFor,
				createAgent: () => fakeAgent(SAFE_REPLY, prompts),
			}),
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("src/Vault.sol");
		expect(prompts[0]).toContain("./IOracle.sol");
		expect(prompts[0]).toContain("execute_code");

		// The inventory pull is journaled as repo_inventory (harness setup,
		// not a model action — the exporter folds it into row metadata).
		const rec = journals.byRepo.get(path.join(root, "repo-a"))!;
		const inventoryWrite = rec.writes.find((w) => w.type === "repo_inventory");
		expect(inventoryWrite).toBeDefined();
		expect(inventoryWrite!.data.ok).toBe(true);
		expect(inventoryWrite!.data.files).toEqual(INVENTORY.files);
	});

	it("resume skips done repos and audits only the rest", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		await runRollout(baseOpts(root));

		await makeRepo(root, "repo-c");
		const seen: string[] = [];
		const events: Record<string, unknown>[] = [];
		const summary = await runRollout(
			baseOpts(root, {
				createAgent: (ctx: RolloutAgentContext) => {
					seen.push(ctx.serving.modelId);
					return fakeAgent(SAFE_REPLY);
				},
				onEvent: (e) => events.push(e),
			}),
		);

		expect(seen).toHaveLength(1); // only repo-c got an agent
		expect(summary.done).toBe(1);
		expect(summary.skipped).toBe(2);
		expect(summary.failed).toBe(0);
		expect(events.filter((e) => e.type === "repo_skipped")).toHaveLength(2);

		const manifest = await readManifest(root);
		expect(manifest.repos["repo-c"].status).toBe("done");
	});

	it("--force re-runs repos already marked done", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		await runRollout(baseOpts(root));

		let agents = 0;
		const summary = await runRollout(
			baseOpts(root, {
				force: true,
				createAgent: () => {
					agents += 1;
					return fakeAgent(SAFE_REPLY);
				},
			}),
		);

		expect(agents).toBe(2);
		expect(summary.done).toBe(2);
		expect(summary.skipped).toBe(0);
	});

	it("resets interrupted (running) repos to pending on startup", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		// Simulate a crash: repo-a died mid-run, repo-b finished earlier.
		const crashed: RolloutManifest = {
			version: 1,
			repos: {
				"repo-a": { status: "running", sessionId: "old-session" },
				"repo-b": { status: "done", sessionId: "done-session", verified: 1 },
			},
		};
		await fs.writeFile(
			path.join(root, ".attis-rollout.json"),
			JSON.stringify(crashed),
		);

		const journals = fakeJournals();
		const summary = await runRollout(baseOpts(root, { journalFor: journals.journalFor }));

		expect(summary.done).toBe(1);
		expect(summary.skipped).toBe(1);
		expect(journals.opened).toEqual([path.join(root, "repo-a")]);

		const manifest = await readManifest(root);
		expect(manifest.repos["repo-a"].status).toBe("done");
		expect(manifest.repos["repo-a"].sessionId).toBe("sess-repo-a");
		expect(manifest.repos["repo-b"].sessionId).toBe("done-session");
	});

	it("honors --manifest and --max-repos", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		await makeRepo(root, "repo-c");
		const manifestPath = path.join(root, "custom-manifest.json");

		const summary = await runRollout(baseOpts(root, { manifestPath, maxRepos: 2 }));

		expect(summary.total).toBe(2);
		expect(summary.done).toBe(2);
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as RolloutManifest;
		expect(Object.keys(manifest.repos).sort()).toEqual(["repo-a", "repo-b"]);
		// The default manifest path was NOT created.
		await expect(fs.stat(path.join(root, ".attis-rollout.json"))).rejects.toThrow();
	});

	it("accepts a single repo dir as the rollout target", async () => {
		const root = await tmpRoot();
		const repo = await makeRepo(root, "lone-repo");

		const summary = await runRollout(baseOpts(repo));

		expect(summary.total).toBe(1);
		expect(summary.done).toBe(1);
		const manifest = await readManifest(repo);
		expect(manifest.repos["lone-repo"].status).toBe("done");
	});

	it("throws on a corrupt manifest instead of silently re-running", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await fs.writeFile(path.join(root, ".attis-rollout.json"), "{not json");

		await expect(runRollout(baseOpts(root))).rejects.toThrow(/corrupt/);
	});
});

// ---------------------------------------------------------------------------
// Failure containment
// ---------------------------------------------------------------------------

describe("runRollout — failure containment", () => {
	it("marks a failed repo and continues with the batch", async () => {
		const root = await tmpRoot();
		const a = await makeRepo(root, "repo-a");
		const b = await makeRepo(root, "repo-b");
		const c = await makeRepo(root, "repo-c");
		const driver = stubDriver({ failFor: "repo-b" });
		const journals = fakeJournals();
		const events: Record<string, unknown>[] = [];

		const summary = await runRollout(
			baseOpts(root, {
				driver: driver.driver,
				journalFor: journals.journalFor,
				onEvent: (e) => events.push(e),
			}),
		);

		expect(summary.done).toBe(2);
		expect(summary.failed).toBe(1);
		expect(summary.results.find((r) => r.repo === "repo-b")?.status).toBe("failed");
		expect(summary.results.find((r) => r.repo === "repo-c")?.status).toBe("done");

		const manifest = await readManifest(root);
		expect(manifest.repos["repo-a"].status).toBe("done");
		expect(manifest.repos["repo-b"].status).toBe("failed");
		expect(manifest.repos["repo-b"].error).toContain("kernel boom");
		expect(manifest.repos["repo-c"].status).toBe("done");

		// The error is journaled on the failed repo's own session.
		const rec = journals.byRepo.get(b)!;
		expect(rec.closed).toHaveLength(1);
		expect(String(rec.closed[0].error)).toContain("kernel boom");

		// Every prepared kernel was cleaned up, and repo-b never prepared one.
		expect(driver.prepared).toEqual([a, c]);
		expect(driver.cleaned).toEqual([a, c]);

		const failedEvents = events.filter((e) => e.type === "repo_failed");
		expect(failedEvents).toHaveLength(1);
		expect(failedEvents[0].repo).toBe("repo-b");
	});

	it("marks the repo failed when the model endpoint errors mid-audit", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		let calls = 0;

		const summary = await runRollout(
			baseOpts(root, {
				createAgent: (ctx) => {
					calls += 1;
					// repo-a's endpoint dies; repo-b audits normally.
					const events = calls === 1 ? [endpointErrorEvent("Connection error.")] : undefined;
					const agent = fakeAgent(SAFE_REPLY, undefined, events);
					(agent as { subscribe: (cb: unknown) => void }).subscribe(ctx.onEvent);
					return agent;
				},
			}),
		);

		expect(summary.done).toBe(1);
		expect(summary.failed).toBe(1);
		const manifest = await readManifest(root);
		expect(manifest.repos["repo-a"].status).toBe("failed");
		expect(manifest.repos["repo-a"].error).toContain("Connection error");
		expect(manifest.repos["repo-b"].status).toBe("done");
	});

	it("contains agent-loop exceptions the same way", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");

		const summary = await runRollout(
			baseOpts(root, {
				createAgent: () => {
					const agent = fakeAgent(SAFE_REPLY);
					(agent as { prompt: (t: string) => Promise<void> }).prompt = async () => {
						throw new Error("endpoint down");
					};
					return agent;
				},
			}),
		);

		expect(summary.failed).toBe(2);
		expect(summary.done).toBe(0);
		const manifest = await readManifest(root);
		expect(manifest.repos["repo-a"].error).toContain("endpoint down");
	});
});

// ---------------------------------------------------------------------------
// Teacher configuration
// ---------------------------------------------------------------------------

describe("teacherServingConfig", () => {
	it("defaults to the serving-manager env-driver contract", () => {
		const cfg = teacherServingConfig("default", {});
		expect(cfg.baseUrl).toBe("http://localhost:8000/v1");
		expect(cfg.modelId).toBe("orgia");
		expect(cfg.apiKeyEnv).toEqual(["ATTIS_API_KEY"]);
	});

	it("prefers ATTIS_VLLM_BASE_URL over ATTIS_BASE_URL", () => {
		const cfg = teacherServingConfig("default", {
			ATTIS_BASE_URL: "http://legacy:8000/v1",
			ATTIS_VLLM_BASE_URL: "http://vllm:8000/v1",
			ATTIS_MODEL: "qwen35-9b",
		});
		expect(cfg.baseUrl).toBe("http://vllm:8000/v1");
		expect(cfg.modelId).toBe("qwen35-9b");
	});

	it("switches to the DEEPSEEK_* triple for --teacher deepseek", () => {
		const cfg = teacherServingConfig("deepseek", {});
		expect(cfg.baseUrl).toBe("https://api.deepseek.com");
		expect(cfg.modelId).toBe("deepseek-v4-pro");
		expect(cfg.apiKeyEnv).toEqual(["DEEPSEEK_API_KEY"]);

		const custom = teacherServingConfig("deepseek", {
			DEEPSEEK_BASE_URL: "https://ds.internal",
			DEEPSEEK_MODEL: "deepseek-v4-pro-0528",
		});
		expect(custom.baseUrl).toBe("https://ds.internal");
		expect(custom.modelId).toBe("deepseek-v4-pro-0528");
	});

	it("runRollout hands the teacher config to the agent factory", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		const seen: RolloutAgentContext[] = [];

		await runRollout(
			baseOpts(root, {
				teacher: "deepseek",
				env: { DEEPSEEK_BASE_URL: "https://ds.internal" },
				createAgent: (ctx) => {
					seen.push(ctx);
					return fakeAgent(SAFE_REPLY);
				},
			}),
		);

		expect(seen).toHaveLength(1);
		expect(seen[0].serving.baseUrl).toBe("https://ds.internal");
		expect(seen[0].serving.modelId).toBe("deepseek-v4-pro");
		expect(seen[0].serving.apiKeyEnv).toEqual(["DEEPSEEK_API_KEY"]);
		// The agent runs kernel-mode: execute_code tool + rollout system prompt.
		expect(seen[0].tools.map((t) => t.name)).toEqual(["execute_code"]);
		expect(seen[0].systemPrompt).toContain("execute_code");
	});
});

// ---------------------------------------------------------------------------
// Journal per repo
// ---------------------------------------------------------------------------

describe("runRollout — journaling", () => {
	it("opens one journal per repo and records the loop events", async () => {
		const root = await tmpRoot();
		const a = await makeRepo(root, "repo-a");
		const b = await makeRepo(root, "repo-b");
		const journals = fakeJournals();

		await runRollout(baseOpts(root, { journalFor: journals.journalFor }));

		expect(journals.opened).toEqual([a, b]);
		for (const repo of [a, b]) {
			const rec = journals.byRepo.get(repo)!;
			const types = rec.writes.map((w) => w.type);
			expect(types).toContain("repo_inventory"); // the harness repo.tree() pull
			expect(types).toContain("audit_prompt");
			expect(types).toContain("findings_parsed");
			expect(types).toContain("report");
			expect(rec.closed).toEqual([{ verified: 0, findings: 0 }]);
		}
	});
});

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

describe("discoverRepos", () => {
	it("treats subdirectories containing Solidity as repos", async () => {
		const root = await tmpRoot();
		await makeRepo(root, "repo-a");
		await makeRepo(root, "repo-b");
		await fs.mkdir(path.join(root, "docs")); // no .sol — not a target

		const repos = await discoverRepos(root);
		expect(repos.map((r) => path.basename(r))).toEqual(["repo-a", "repo-b"]);
	});

	it("treats a dir with top-level .sol as a single repo", async () => {
		const root = await tmpRoot();
		await fs.writeFile(path.join(root, "Vault.sol"), "contract Vault {}\n");
		await makeRepo(root, "nested");

		expect(await discoverRepos(root)).toEqual([root]);
	});

	it("treats a dir with a repo marker as a single repo", async () => {
		const root = await tmpRoot();
		await fs.writeFile(path.join(root, "foundry.toml"), "[profile.default]\n");

		expect(await discoverRepos(root)).toEqual([root]);
	});

	it("finds .sol in nested dirs of a subdirectory repo", async () => {
		const root = await tmpRoot();
		await fs.mkdir(path.join(root, "contracts", "deep"), { recursive: true });
		await fs.writeFile(path.join(root, "contracts", "deep", "V.sol"), "contract V {}\n");

		// contracts/ has no top-level .sol; discovery walks it recursively.
		const repos = await discoverRepos(root);
		expect(repos.map((r) => path.basename(r))).toEqual(["contracts"]);
	});

	it("throws when the target is not a directory or has no repos", async () => {
		const root = await tmpRoot();
		await expect(discoverRepos(path.join(root, "nope"))).rejects.toThrow(/not a directory/);
		await expect(discoverRepos(root)).rejects.toThrow(/no Solidity repos/);
	});
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

describe("parseRolloutArgs", () => {
	it("parses a bare repos root with defaults", () => {
		expect(parseRolloutArgs(["repos"])).toEqual({
			rootDir: "repos",
			teacher: "default",
			force: false,
			output: "text",
		});
	});

	it("parses all flags", () => {
		expect(
			parseRolloutArgs([
				"repos",
				"--teacher",
				"deepseek",
				"--force",
				"--output",
				"stream-json",
				"--max-repos",
				"3",
				"--manifest",
				"state.json",
			]),
		).toEqual({
			rootDir: "repos",
			teacher: "deepseek",
			force: true,
			output: "stream-json",
			maxRepos: 3,
			manifestPath: "state.json",
		});
	});

	it("rejects bad input", () => {
		expect(() => parseRolloutArgs([])).toThrow(/missing repos root/);
		expect(() => parseRolloutArgs(["repos", "--teacher", "gpt"])).toThrow(/--teacher/);
		expect(() => parseRolloutArgs(["repos", "--output", "yaml"])).toThrow(/--output/);
		expect(() => parseRolloutArgs(["repos", "--max-repos", "0"])).toThrow(/--max-repos/);
		expect(() => parseRolloutArgs(["repos", "--max-repos", "two"])).toThrow(/--max-repos/);
		expect(() => parseRolloutArgs(["repos", "--bogus"])).toThrow(/unknown flag/);
		expect(() => parseRolloutArgs(["a", "b"])).toThrow(/unexpected argument/);
	});
});
