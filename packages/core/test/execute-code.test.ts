/**
 * execute_code tool tests — stubbed kernel (no python), real execpolicy,
 * capturing journal. Covers schema validity, policy gating, journaling,
 * and the kernel-restart event.
 */
import { describe, expect, it } from "vitest";
import type { ExecResult, Kernel } from "@attis/kernel";
import { loadPolicy } from "@attis/kernel";
import type { Journal } from "@attis/journal";
import { createExecuteCodeTool } from "../src/tools/execute-code.js";

function result(overrides: Partial<ExecResult> = {}): ExecResult {
	return {
		ok: true,
		stdout: "",
		stderr: "",
		result: "2",
		error: null,
		restarted: false,
		durationMs: 3,
		...overrides,
	};
}

function harness(execImpl: (code: string) => Promise<ExecResult>) {
	const calls: string[] = [];
	const kernel: Kernel = {
		exec: async (code) => {
			calls.push(code);
			return execImpl(code);
		},
		stop: async () => {},
		pid: 1234,
		restartCount: 0,
	};
	const writes: { type: string; data: Record<string, unknown> }[] = [];
	const journal = {
		write: async (type: string, data: Record<string, unknown>) => {
			writes.push({ type, data });
		},
	} as unknown as Journal;
	const tool = createExecuteCodeTool({
		kernel,
		policy: loadPolicy("policy/execpolicy.json"),
		journal,
	});
	return { tool, calls, writes };
}

describe("execute_code tool", () => {
	it("has a valid schema and resolveExecution metadata", () => {
		const { tool } = harness(async () => result());
		expect(tool.name).toBe("execute_code");
		const schema = tool.parameters as { type?: string; required?: string[]; properties?: Record<string, unknown> };
		expect(schema.type).toBe("object");
		expect(schema.required).toContain("code");
		expect(Object.keys(schema.properties ?? {})).toContain("timeout_ms");
		const meta = tool.resolveExecution();
		expect(meta.accesses).toEqual(["kernel", "scratch", "anvil-pool"]);
		expect(meta.approvalRule).toBe("policy");
	});

	it("executes code via the kernel and journals the execution", async () => {
		const { tool, calls, writes } = harness(async () => result());
		const r = await tool.execute("t1", { code: "1 + 1" });
		expect(calls).toEqual(["1 + 1"]);
		const payload = JSON.parse(r.content[0].text as string) as { ok: boolean; result: string };
		expect(payload.ok).toBe(true);
		expect(payload.result).toBe("2");
		expect(writes).toHaveLength(1);
		expect(writes[0].type).toBe("kernel_exec");
		expect(writes[0].data.code).toBe("1 + 1");
		expect(writes[0].data.ok).toBe(true);
	});

	it("passes timeout_ms through to the kernel", async () => {
		let seen: number | undefined;
		const kernel: Kernel = {
			exec: async (_code, opts) => {
				seen = opts?.timeoutMs;
				return result();
			},
			stop: async () => {},
			pid: 1,
			restartCount: 0,
		};
		const journal = { write: async () => {} } as unknown as Journal;
		const tool = createExecuteCodeTool({
			kernel,
			policy: loadPolicy("policy/execpolicy.json"),
			journal,
		});
		await tool.execute("t1", { code: "x", timeout_ms: 5000 });
		expect(seen).toBe(5000);
	});

	it("blocks policy-forbidden code before it reaches the kernel", async () => {
		const { tool, calls, writes } = harness(async () => result());
		const r = await tool.execute("t1", {
			code: "import requests\nrequests.get('http://evil.example')",
		});
		expect(calls).toHaveLength(0);
		const payload = JSON.parse(r.content[0].text as string) as { ok: boolean; blocked: boolean; reason: string };
		expect(payload.ok).toBe(false);
		expect(payload.blocked).toBe(true);
		expect(payload.reason).toContain("execpolicy");
		expect(writes[0].type).toBe("kernel_exec");
		expect(writes[0].data.blocked).toBe(true);
	});

	it("blocks raw-key shelling (cast send --private-key literal)", async () => {
		const { tool, calls } = harness(async () => result());
		const r = await tool.execute("t1", {
			code: "import subprocess\nsubprocess.run(['cast', 'send', '--private-key', '0xdead'])",
		});
		expect(calls).toHaveLength(0);
		expect((JSON.parse(r.content[0].text as string) as { blocked: boolean }).blocked).toBe(true);
	});

	it("journals a kernel_restart when the kernel came back fresh", async () => {
		const { tool, writes } = harness(async () => result({ restarted: true }));
		const r = await tool.execute("t1", { code: "1 + 1" });
		const types = writes.map((w) => w.type);
		expect(types).toContain("kernel_restart");
		expect(types).toContain("kernel_exec");
		const payload = JSON.parse(r.content[0].text as string) as { restarted: boolean };
		expect(payload.restarted).toBe(true);
	});

	it("surfaces kernel errors as structured results (not throws)", async () => {
		const { tool } = harness(async () =>
			result({
				ok: false,
				result: null,
				error: { type: "ZeroDivisionError", message: "division by zero", traceback: "..." },
			}),
		);
		const r = await tool.execute("t1", { code: "1/0" });
		const payload = JSON.parse(r.content[0].text as string) as {
			ok: boolean;
			error: { type: string };
		};
		expect(payload.ok).toBe(false);
		expect(payload.error.type).toBe("ZeroDivisionError");
	});
});
