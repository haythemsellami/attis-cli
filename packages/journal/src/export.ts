/**
 * @attis/journal export — journal → orgia-llm training rows (roadmap v2 item 5).
 *
 * Maps a session's events.jsonl to a ShareGPT row in the native OpenAI
 * function-calling wire — the format the runtime already speaks end to end
 * (docs/vision-versions.md: no marker fallback), so export is a mapping, not
 * a conversion: audit_prompt → system+user, kernel_exec → assistant tool_call
 * + tool result, audit_result / poc_generated / report → assistant messages,
 * fork_verdict → the verification's tool result + the row's quality label.
 *
 * Labels: any verified finding (fork_verdict verified / finding_kept /
 * kernel fork.verify ATTIS_FORK_VERDICT marker) → gold_positive; only
 * failed verifications (reverted beyond retries / finding_dropped with
 * verification_failed / failed kernel verdicts) → hard_negative; audit
 * concluded safe or parsed zero findings → safe_verdict; findings reported
 * with zero fork verdicts → unverified_findings; no findings_parsed event
 * at all → unlabeled (degenerate/incomplete).
 *
 * Every row is validated before it ships (role order, tool_call pairing,
 * JSON arguments, non-empty content). Invalid rows are dropped with a
 * warning, never silently salvaged — events that journal only char counts
 * (v1's audit_prompt / audit_result / poc_generated) export at reduced
 * fidelity and their rows drop if required text is missing.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { contentHash, safeName, type JournalEvent } from "./index.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: MessageRole;
	content: string;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export type RowLabel =
	| "gold_positive" // fork-verified finding(s) present
	| "hard_negative" // verification attempted, failed/reverted
	| "safe_verdict" // audit concluded safe / zero findings parsed
	| "unverified_findings" // findings reported, zero fork verdicts
	| "unlabeled"; // degenerate: no findings_parsed event at all

/** Canonical verdict marker printed by the kernel's fork.verify helper —
 *  the repo-mode ground truth for labels (v1's fork_verdict events only
 *  exist in the deterministic single-contract path). */
export const FORK_VERDICT_MARKER = "ATTIS_FORK_VERDICT ";

export interface RowMetadata {
	session_id: string;
	/** contentHash of the audited workdir (flywheel dedup). */
	repo_hash: string;
	source: "attis-rollout";
	/** Timestamp of the session's first journaled event. */
	ts: string;
	label: RowLabel;
	verified_findings: number;
	dropped_findings: number;
	kernel_execs: number;
	/** Repo file count from the harness inventory pull, when journaled. */
	inventory_files?: number;
}

export interface TrainingRow {
	messages: ChatMessage[];
	metadata: RowMetadata;
}

export interface SessionExport {
	rows: TrainingRow[];
	dropped: number;
	warnings: string[];
}

export interface RolloutExport extends SessionExport {
	/** Sessions actually read and exported (rows may still have dropped). */
	sessions: number;
}

/** One repo's rollout status — the fields both manifest shapes share. */
export interface ManifestRepoEntry {
	status: "pending" | "running" | "done" | "failed";
	sessionId?: string;
	eventsPath?: string;
	verified?: number;
	error?: string;
}

/** Array-form manifest entry (path inline). */
export interface RolloutRepo extends ManifestRepoEntry {
	path: string;
}

/**
 * Rollout manifest (.attis-rollout.json — built by `attis rollout`, roadmap
 * item 3). Two shapes are accepted: the array form ({repos: [{path, ...}]})
 * and the record form the rollout writer emits ({version, repos: {<path>:
 * {...}}}); both normalize to the same entries.
 */
export type RolloutManifest =
	| { repos: RolloutRepo[] }
	| { version?: number; repos: Record<string, ManifestRepoEntry> };

/** Normalize either manifest shape to array-form entries. */
function manifestRepos(raw: unknown): RolloutRepo[] {
	if (Array.isArray(raw)) {
		return raw.filter((r): r is RolloutRepo => typeof r === "object" && r !== null);
	}
	if (typeof raw === "object" && raw !== null) {
		return Object.entries(raw as Record<string, ManifestRepoEntry>).map(([path, entry]) => ({
			...entry,
			path,
		}));
	}
	return [];
}

/**
 * Fallback system prompt when audit_prompt doesn't journal the one used at
 * runtime — verbatim from orgia-llm's train.jsonl so exported rows stay in
 * the trained distribution. Rollout loops should journal `system` explicitly.
 */
export const DEFAULT_SYSTEM_PROMPT =
	"You are an expert Solidity/EVM security auditor. Analyze the provided code for vulnerabilities.\n\n" +
	"For each finding, report:\n" +
	"- **Severity:** Critical, High, Medium, or Low\n" +
	"- **Location:** function name and/or line reference\n" +
	"- **Issue:** what's wrong\n" +
	"- **Impact:** what an attacker could do\n" +
	"- **Remediation:** how to fix it\n\n" +
	"If the code is safe, say \"No issues found\" and briefly explain why the seemingly\n" +
	"suspicious patterns are actually safe. Do not invent vulnerabilities.";

/**
 * Validate a row against the native wire: optional system, one user prompt,
 * then assistant/tool messages where every tool result answers a tool_call
 * from the immediately preceding assistant message, arguments parse as JSON,
 * and no content is empty (assistant messages with tool_calls may carry
 * empty content — per-call reasoning is not journaled). Returns the list of
 * problems; empty means the row is loadable.
 */
export function validateRow(row: TrainingRow): string[] {
	const problems: string[] = [];
	const msgs = row.messages;
	if (msgs.length === 0) return ["row has no messages"];

	let i = 0;
	if (msgs[0].role === "system") {
		if (!msgs[0].content.trim()) problems.push("system message has empty content");
		i = 1;
	}
	if (i < msgs.length && msgs[i].role === "user") {
		if (!msgs[i].content.trim()) problems.push("user message has empty content");
		i++;
	} else {
		problems.push("first non-system message must be the user prompt");
	}

	let assistantCount = 0;
	let pending: string[] = []; // unanswered tool_call ids from the last assistant message
	for (; i < msgs.length; i++) {
		const m = msgs[i];
		if (m.role === "assistant") {
			assistantCount++;
			const calls = m.tool_calls ?? [];
			if (!m.content.trim() && calls.length === 0) {
				problems.push(`message ${i}: assistant message has empty content and no tool_calls`);
			}
			for (const call of calls) {
				if (!call.id) problems.push(`message ${i}: tool_call without id`);
				if (call.type !== "function") problems.push(`message ${i}: tool_call ${call.id} type must be "function"`);
				if (!call.function.name) problems.push(`message ${i}: tool_call ${call.id} without function name`);
				try {
					JSON.parse(call.function.arguments);
				} catch {
					problems.push(`message ${i}: tool_call ${call.id} arguments is not valid JSON`);
				}
			}
			pending = calls.map((c) => c.id);
			continue;
		}
		if (m.role === "tool") {
			if (!m.content.trim()) problems.push(`message ${i}: tool result has empty content`);
			const at = pending.indexOf(m.tool_call_id ?? "");
			if (at === -1) {
				problems.push(`message ${i}: tool result ${m.tool_call_id ?? "(no id)"} has no preceding tool_call`);
			} else {
				pending.splice(at, 1);
			}
			continue;
		}
		problems.push(`message ${i}: ${m.role} is not allowed after the prompt`);
	}
	if (assistantCount === 0) problems.push("row has no assistant message");
	return problems;
}

interface SessionState {
	messages: ChatMessage[];
	warnings: string[];
	workdir?: string;
	ts?: string;
	callSeq: number;
	pendingPoc: { message: ChatMessage; code: string; title: string } | null;
	sawVerified: boolean;
	sawFailed: boolean;
	kept: number;
	droppedFindings: number;
	kernelExecs: number;
	seenPrompt: boolean;
	inventoryFiles?: number;
	/** Max findings count across findings_parsed events (0 once parsed). */
	findingsReported: number;
	sawSafe: boolean;
	sawFindingsParsed: boolean;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Rebuild the model-facing tool result — mirrors modelPayload() in
 *  packages/core/src/tools/execute-code.ts (keep the strings in sync). */
function kernelResultContent(data: Record<string, unknown>): string {
	if (data.blocked === true) {
		const hits = Array.isArray(data.policy_hits)
			? data.policy_hits.filter((h): h is string => typeof h === "string")
			: [];
		return JSON.stringify({
			ok: false,
			blocked: true,
			reason:
				`execpolicy forbids: ${hits.join(", ")}. Network access and raw keys are not ` +
				"available in the kernel — use the fork helpers instead.",
		});
	}
	const payload: Record<string, unknown> = {
		ok: data.ok === true,
		stdout: typeof data.stdout === "string" ? data.stdout : "",
		stderr: typeof data.stderr === "string" ? data.stderr : "",
		result: data.result ?? null,
		error: data.error ?? null,
	};
	if (data.restarted === true) {
		payload.restarted = true;
		payload.note = "kernel restarted — previous namespace is gone; re-declare variables";
	}
	return JSON.stringify(payload);
}

function mapKernelExec(st: SessionState, data: Record<string, unknown>): void {
	const code = str(data.code);
	if (!code) {
		st.warnings.push("kernel_exec without code — tool_call pair skipped");
		return;
	}
	// Kernel-side fork.verify prints a canonical marker into stdout — this is
	// the repo-mode ground truth the label keys on (v1's fork_verdict events
	// only exist in the deterministic single-contract path).
	const stdout = typeof data.stdout === "string" ? data.stdout : "";
	for (const line of stdout.split("\n")) {
		if (!line.startsWith(FORK_VERDICT_MARKER)) continue;
		try {
			const marker = JSON.parse(line.slice(FORK_VERDICT_MARKER.length)) as { verdict?: string };
			if (marker.verdict === "verified") st.sawVerified = true;
			else if (marker.verdict) st.sawFailed = true;
		} catch {
			st.warnings.push("malformed ATTIS_FORK_VERDICT marker — ignored for the label");
		}
	}
	const id = `call_${st.callSeq++}`;
	st.messages.push({
		role: "assistant",
		content: "",
		tool_calls: [
			{ id, type: "function", function: { name: "execute_code", arguments: JSON.stringify({ code }) } },
		],
	});
	st.messages.push({ role: "tool", tool_call_id: id, content: kernelResultContent(data) });
	st.kernelExecs++;
}

/** A poc_generated without its fork_verdict still ships as plain assistant content. */
function flushPoc(st: SessionState): void {
	if (!st.pendingPoc) return;
	st.warnings.push(`poc "${st.pendingPoc.title}" has no fork_verdict — exported unverified`);
	st.messages.push(st.pendingPoc.message);
	st.pendingPoc = null;
}

function mapPocGenerated(st: SessionState, data: Record<string, unknown>): void {
	flushPoc(st); // a second poc before a verdict means the first was never verified
	const title = str(data.title) ?? "untitled finding";
	const attempt = num(data.attempt) ?? 0;
	const code = str(data.code) ?? str(data.poc);
	if (!code) {
		st.warnings.push(
			`poc_generated "${title}" carries no code (v1 journals record poc_chars only) — skipped`,
		);
		return;
	}
	st.pendingPoc = {
		code,
		title,
		message: {
			role: "assistant",
			content: `PoC for "${title}" (attempt ${attempt}):\n\n\`\`\`solidity\n${code}\n\`\`\``,
		},
	};
}

function mapForkVerdict(st: SessionState, data: Record<string, unknown>): void {
	const title = str(data.title) ?? "untitled finding";
	const verified = data.verified === true;
	if (verified) st.sawVerified = true;
	else st.sawFailed = true;
	const poc = st.pendingPoc;
	if (!poc) {
		st.warnings.push(`fork_verdict "${title}" has no preceding poc_generated — counted for the label only`);
		return;
	}
	st.pendingPoc = null;
	// The verification rides the only model-facing tool: the PoC assistant
	// message gets an execute_code tool_call, the verdict is its tool result.
	const id = `call_${st.callSeq++}`;
	poc.message.tool_calls = [
		{ id, type: "function", function: { name: "execute_code", arguments: JSON.stringify({ code: poc.code }) } },
	];
	st.messages.push(poc.message);
	st.messages.push({
		role: "tool",
		tool_call_id: id,
		content: JSON.stringify({
			ok: verified,
			verified,
			title,
			attempt: num(data.attempt) ?? 0,
			trace: str(data.trace) ?? null,
		}),
	});
}

/**
 * Export one session journal (events.jsonl) to a validated training row.
 * One session = one trajectory = at most one row; the array leaves room for
 * per-finding splitting later without an API change.
 */
export async function exportSession(eventsPath: string): Promise<SessionExport> {
	const warnings: string[] = [];
	let raw: string;
	try {
		raw = await fs.readFile(eventsPath, "utf-8");
	} catch (err) {
		return { rows: [], dropped: 0, warnings: [`cannot read ${eventsPath}: ${errMessage(err)}`] };
	}
	const events: JournalEvent[] = [];
	raw.split("\n").forEach((line, idx) => {
		if (!line.trim()) return;
		try {
			const parsed = JSON.parse(line) as Partial<JournalEvent> | null;
			if (
				typeof parsed !== "object" || parsed === null ||
				typeof parsed.type !== "string" ||
				typeof parsed.data !== "object" || parsed.data === null
			) {
				warnings.push(`line ${idx + 1}: not a journal event — skipped`);
				return;
			}
			events.push(parsed as JournalEvent);
		} catch {
			warnings.push(`line ${idx + 1}: invalid JSON — skipped`);
		}
	});

	const st: SessionState = {
		messages: [],
		warnings,
		callSeq: 0,
		pendingPoc: null,
		sawVerified: false,
		sawFailed: false,
		kept: 0,
		droppedFindings: 0,
		kernelExecs: 0,
		seenPrompt: false,
		findingsReported: 0,
		sawSafe: false,
		sawFindingsParsed: false,
	};

	for (const ev of events) {
		st.ts = st.ts ?? str(ev.ts);
		switch (ev.type) {
			case "session_start":
				st.workdir = str(ev.data.workdir) ?? st.workdir;
				break;
			case "audit_prompt": {
				if (st.seenPrompt) {
					st.warnings.push("duplicate audit_prompt — ignored");
					break;
				}
				st.seenPrompt = true;
				st.messages.push({ role: "system", content: str(ev.data.system) ?? DEFAULT_SYSTEM_PROMPT });
				st.messages.push({ role: "user", content: str(ev.data.prompt) ?? "" });
				if (!str(ev.data.prompt)) {
					st.warnings.push("audit_prompt carries no prompt text (v1 journals record chars only)");
				}
				break;
			}
			case "kernel_exec":
				if (!st.seenPrompt) {
					st.warnings.push("kernel_exec before the audit prompt (harness setup) — skipped");
					break;
				}
				mapKernelExec(st, ev.data);
				break;
			case "repo_inventory":
				// Harness setup (rollout's repo.tree() pull), not model behavior —
				// the inventory already rides inside the audit prompt text.
				if (Array.isArray(ev.data.files)) st.inventoryFiles = ev.data.files.length;
				break;
			case "kernel_restart":
				break; // the restarted kernel_exec already carries the model-visible note
			case "audit_result": {
				const output = str(ev.data.output);
				if (output) st.messages.push({ role: "assistant", content: output });
				break;
			}
			case "findings_parsed": {
				st.sawFindingsParsed = true;
				st.findingsReported = Math.max(st.findingsReported, num(ev.data.count) ?? 0);
				if (ev.data.isSafe === true) st.sawSafe = true;
				const text = str(ev.data.text) ?? str(ev.data.output);
				if (text) st.messages.push({ role: "assistant", content: text });
				break;
			}
			case "poc_generated":
				mapPocGenerated(st, ev.data);
				break;
			case "fork_verdict":
				mapForkVerdict(st, ev.data);
				break;
			case "finding_kept":
				st.kept++;
				break;
			case "finding_dropped":
				st.droppedFindings++;
				if (ev.data.reason === "verification_failed") st.sawFailed = true;
				break;
			case "report": {
				const text = str(ev.data.text);
				if (text) st.messages.push({ role: "assistant", content: text });
				break;
			}
			default:
				break; // session_end, judge_* — harness-side, not transcript
		}
	}
	flushPoc(st);

	const label: RowLabel =
		st.sawVerified || st.kept > 0
			? "gold_positive"
			: st.sawFailed
				? "hard_negative"
				: !st.sawFindingsParsed
					? "unlabeled"
					: st.sawSafe || st.findingsReported === 0
						? "safe_verdict"
						: "unverified_findings";
	const row: TrainingRow = {
		messages: st.messages,
		metadata: {
			session_id: path.basename(path.dirname(eventsPath)),
			repo_hash: contentHash(st.workdir ?? eventsPath),
			source: "attis-rollout",
			ts: st.ts ?? new Date().toISOString(),
			label,
			verified_findings: st.kept,
			dropped_findings: st.droppedFindings,
			kernel_execs: st.kernelExecs,
			...(st.inventoryFiles !== undefined ? { inventory_files: st.inventoryFiles } : {}),
		},
	};

	const problems = validateRow(row);
	if (problems.length > 0) {
		return {
			rows: [],
			dropped: 1,
			warnings: [...st.warnings, ...problems.map((p) => `row dropped: ${p}`)],
		};
	}
	return { rows: [row], dropped: 0, warnings: st.warnings };
}

/** ~/.attis/sessions/<safeName(repo)>/<sessionId>/events.jsonl — mirrors Journal.open. */
function resolveEventsPath(repo: RolloutRepo, manifestDir: string): string | null {
	if (repo.eventsPath) {
		return path.isAbsolute(repo.eventsPath) ? repo.eventsPath : path.resolve(manifestDir, repo.eventsPath);
	}
	if (repo.sessionId) {
		// Manifest keys are repo paths relative to the repos root (the
		// manifest's dir); journals key on the ABSOLUTE path's safeName.
		// Single-repo rollouts: root IS the repo, key is its basename.
		const repoPath = path.isAbsolute(repo.path)
			? repo.path
			: path.basename(manifestDir) === repo.path
				? manifestDir
				: path.resolve(manifestDir, repo.path);
		return path.join(os.homedir(), ".attis", "sessions", safeName(repoPath), repo.sessionId, "events.jsonl");
	}
	return null;
}

async function findEventsFiles(dir: string, depth = 0): Promise<string[]> {
	if (depth > 2) return []; // <dir>/<workdir>/<sessionId>/events.jsonl
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const found: string[] = [];
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) found.push(...(await findEventsFiles(p, depth + 1)));
		else if (e.isFile() && e.name === "events.jsonl") found.push(p);
	}
	return found.sort();
}

/**
 * Batch export: a rollout manifest (.attis-rollout.json — exports every
 * `done` repo) or a sessions directory (exports every events.jsonl found).
 * Per-session failures are warnings, never fatal.
 */
export async function exportRollout(manifestOrDir: string): Promise<RolloutExport> {
	const out: RolloutExport = { rows: [], dropped: 0, warnings: [], sessions: 0 };
	const stat = await fs.stat(manifestOrDir).catch(() => null);
	if (!stat) {
		out.warnings.push(`rollout path not found: ${manifestOrDir}`);
		return out;
	}

	const eventsPaths: string[] = [];
	if (stat.isDirectory()) {
		eventsPaths.push(...(await findEventsFiles(manifestOrDir)));
		if (eventsPaths.length === 0) out.warnings.push(`no events.jsonl found under ${manifestOrDir}`);
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.readFile(manifestOrDir, "utf-8"));
		} catch (err) {
			out.warnings.push(`cannot parse manifest ${manifestOrDir}: ${errMessage(err)}`);
			return out;
		}
		const manifestDir = path.dirname(manifestOrDir);
		for (const repo of manifestRepos((parsed as RolloutManifest).repos)) {
			if (typeof repo.path !== "string") {
				out.warnings.push("manifest repo entry without a path — skipped");
				continue;
			}
			if (repo.status !== "done") continue;
			const eventsPath = resolveEventsPath(repo, manifestDir);
			if (!eventsPath) {
				out.warnings.push(`${repo.path}: done but neither eventsPath nor sessionId — skipped`);
				continue;
			}
			eventsPaths.push(eventsPath);
		}
	}

	for (const eventsPath of eventsPaths) {
		if ((await fs.stat(eventsPath).catch(() => null)) === null) {
			out.warnings.push(`${eventsPath}: session events not found — skipped`);
			continue;
		}
		const session = await exportSession(eventsPath);
		out.sessions++;
		out.rows.push(...session.rows);
		out.dropped += session.dropped;
		out.warnings.push(...session.warnings.map((w) => `${eventsPath}: ${w}`));
	}
	return out;
}
