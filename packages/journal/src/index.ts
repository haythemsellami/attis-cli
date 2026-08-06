/**
 * @attis/journal — the wire journal (spec §9).
 *
 * Every run appends NDJSON events to ~/.attis/sessions/<workdir>/<id>/events.jsonl:
 * prompts, step requests, tool calls + args, PoC sources, fork responses,
 * verdicts, findings. Flywheel-ready: a verified-finding entry carries
 * everything an orgia-llm training row needs (code, thinking, finding, PoC,
 * fork verdict) — direct export is a mapping, not an archaeology dig.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type JournalEventType =
	| "session_start"
	| "audit_prompt"
	| "audit_result"
	| "findings_parsed"
	| "poc_generated"
	| "fork_verdict"
	| "finding_kept"
	| "finding_dropped"
	| "kernel_exec"
	| "kernel_restart"
	| "judge_verdict"
	| "judge_error"
	| "report"
	| "session_end";

export interface JournalEvent {
	ts: string;
	type: JournalEventType;
	/** Free-form per-type payload — typed per emitter, documented per use. */
	data: Record<string, unknown>;
}

export interface SessionInfo {
	id: string;
	dir: string;
	eventsPath: string;
}

function safeName(p: string): string {
	return p.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(-80) || "root";
}

export class Journal {
	readonly session: SessionInfo;
	private stream: fs.FileHandle | null = null;

	private constructor(session: SessionInfo) {
		this.session = session;
	}

	static async open(workdir: string, id?: string): Promise<Journal> {
		const sessionId = id ?? new Date().toISOString().replace(/[:.]/g, "-");
		const dir = path.join(
			os.homedir(), ".attis", "sessions", safeName(workdir), sessionId,
		);
		await fs.mkdir(dir, { recursive: true });
		const eventsPath = path.join(dir, "events.jsonl");
		const j = new Journal({ id: sessionId, dir, eventsPath });
		j.stream = await fs.open(eventsPath, "a");
		await j.write("session_start", { workdir });
		return j;
	}

	async write(type: JournalEventType, data: Record<string, unknown>): Promise<void> {
		const ev: JournalEvent = { ts: new Date().toISOString(), type, data };
		await this.stream!.appendFile(JSON.stringify(ev) + "\n");
	}

	async close(summary?: Record<string, unknown>): Promise<void> {
		await this.write("session_end", summary ?? {});
		await this.stream!.close();
		this.stream = null;
	}
}

/** Hash helper for flywheel dedup (same code+chain → same audit id when needed). */
export function contentHash(s: string): string {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}
