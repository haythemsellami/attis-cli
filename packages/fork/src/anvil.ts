/**
 * anvil process manager — spawn, health-check, kill, restart-on-death.
 *
 * Two modes:
 * - plain: fresh local chain (source-only audits; PoCs deploy their own state)
 * - fork: `anvil --fork-url $RPC_URL [--fork-block-number N]` (mainnet state)
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface AnvilHandle {
	port: number;
	pid: number;
	kill: () => Promise<void>;
	/** Restart a dead anvil with the same options (spec §5 ForkDied handler). */
	restart: () => Promise<AnvilHandle>;
}

export interface AnvilOptions {
	forkUrl?: string;
	blockNumber?: number;
	port?: number;
	readyTimeoutMs?: number;
}

async function rpcOk(port: number): Promise<boolean> {
	try {
		const resp = await fetch(`http://127.0.0.1:${port}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
			signal: AbortSignal.timeout(1500),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

function pickPort(preferred?: number): number {
	if (preferred) return preferred;
	// Deterministic-ish free port in a high range; collisions just retry.
	return 18545 + Math.floor(Math.random() * 4000);
}

export async function startAnvil(opts: AnvilOptions = {}): Promise<AnvilHandle> {
	const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

	const launch = async (): Promise<AnvilHandle> => {
		const port = pickPort(opts.port);
		const args = ["--port", String(port), "--silent"];
		if (opts.forkUrl) {
			args.push("--fork-url", opts.forkUrl);
			if (opts.blockNumber) args.push("--fork-block-number", String(opts.blockNumber));
		}
		const child: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
		if (!child.pid) throw new Error("failed to spawn anvil");

		const deadline = Date.now() + readyTimeoutMs;
		while (Date.now() < deadline) {
			if (await rpcOk(port)) {
				const handle: AnvilHandle = {
					port,
					pid: child.pid!,
					kill: () =>
						new Promise<void>((resolve) => {
							if (child.killed) return resolve();
							child.once("exit", () => resolve());
							child.kill("SIGTERM");
							setTimeout(() => {
								if (!child.killed) child.kill("SIGKILL");
								resolve();
							}, 3000);
						}),
					restart: () => launch(),
				};
				return handle;
			}
			if (child.exitCode !== null) {
				throw new Error(`anvil exited early (code ${child.exitCode}) — check forge/anvil install`);
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		child.kill("SIGKILL");
		throw new Error(`anvil on port ${port} did not become ready in ${readyTimeoutMs}ms`);
	};

	return launch();
}
