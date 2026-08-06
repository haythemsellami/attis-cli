/**
 * Test doubles for the process-runner seam (src/drivers/runner.ts) — tests
 * never touch real runpodctl/ssh/vllm processes.
 */
import type {
	CommandResult,
	ExecRunner,
	ManagedChild,
	SpawnOptions,
	SpawnRunner,
} from "../src/drivers/runner.js";

export interface ExecCall {
	command: string;
	args: readonly string[];
}

export type ExecHandler = (
	command: string,
	args: readonly string[],
) => CommandResult | Promise<CommandResult>;

export function createFakeExec(handler: ExecHandler): { exec: ExecRunner; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const exec: ExecRunner = async (command, args) => {
		calls.push({ command, args });
		return handler(command, args);
	};
	return { exec, calls };
}

/** Compact view of exec calls for assertions, e.g. "pod get pod-1". */
export function execLines(calls: ExecCall[]): string[] {
	return calls.map((c) => c.args.join(" "));
}

export class FakeChild implements ManagedChild {
	readonly killCalls: string[] = [];
	unrefCalled = false;
	/** Test hook: invoked from kill() after recording. */
	onKill?: (signal: string) => void;
	private exit: { code: number | null; signal: string | null } | null = null;
	private listeners: ((code: number | null, signal: string | null) => void)[] = [];

	constructor(readonly pid: number | undefined = 4321) {}

	get exitCode(): number | null {
		return this.exit?.code ?? null;
	}

	kill(signal = "SIGTERM"): boolean {
		this.killCalls.push(signal);
		this.onKill?.(signal);
		return true;
	}

	onceExit(listener: (code: number | null, signal: string | null) => void): void {
		if (this.exit) {
			listener(this.exit.code, this.exit.signal);
			return;
		}
		this.listeners.push(listener);
	}

	unref(): void {
		this.unrefCalled = true;
	}

	/** Test control: pretend the process exited. */
	emitExit(code: number | null, signal: string | null = null): void {
		if (this.exit) return;
		this.exit = { code, signal };
		for (const l of this.listeners.splice(0)) l(code, signal);
	}
}

export interface SpawnCall {
	command: string;
	args: readonly string[];
	opts?: SpawnOptions;
}

export type SpawnHandler = (
	command: string,
	args: readonly string[],
	opts?: SpawnOptions,
) => FakeChild;

export function createFakeSpawn(handler: SpawnHandler): {
	spawn: SpawnRunner;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const spawn: SpawnRunner = (command, args, opts) => {
		calls.push({ command, args, opts });
		return handler(command, args, opts);
	};
	return { spawn, calls };
}
