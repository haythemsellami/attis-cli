/**
 * @attis/core eval judge — DeepSeek semantic judge (spec §8: `judge_semantic`,
 * harness-side, ask-before-network per §11).
 *
 * Port of orgia-llm `data_pipeline/eval/judge.py` (DeepSeekJudge.judge). The
 * prompt is ported near-verbatim — judge prompt drift changes eval numbers,
 * and orgia-llm's judge_control exists to catch exactly that. Verdicts:
 * "same" (paraphrase of the expected bug → TP), "valid" (a real, different
 * bug → TP-alt), "invalid" (hallucinated → stays FP).
 *
 * Network gating: the judge object carries `requiresNetwork: true` metadata
 * for the harness permission chain, and an optional `confirm` callback runs
 * before every request. The API key is never logged, journaled, or included
 * in error messages (error bodies are defensively scrubbed).
 */
import type { Finding } from "../findings.js";
import type { ExpectedBug } from "./scorer.js";

export const DEFAULT_JUDGE_MODEL = "deepseek-v4-pro";
export const DEFAULT_JUDGE_BASE_URL = "https://api.deepseek.com";
const MAX_CONTEXT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** Python judge() system message — verbatim. */
export const JUDGE_SYSTEM_PROMPT =
	"You are a precise security audit judge. Reply in JSON only.";

export type JudgeVerdictKind = "same" | "valid" | "invalid";

export interface JudgeVerdict {
	verdict: JudgeVerdictKind;
	/** The judge's reason, truncated to 200 chars (Python parity). */
	rationale: string;
}

export interface ParsedVerdict {
	index: number;
	verdict: JudgeVerdictKind;
	reason: string;
}

/** What the confirm hook sees — redacted, never the API key. */
export interface JudgeRequestInfo {
	kind: "judge_semantic";
	model: string;
	baseUrl: string;
	reportedTitle: string;
	expectedTitle: string;
	contextChars: number;
}

/** Minimal journal sink — structurally satisfied by @attis/journal's Journal. */
export interface JudgeEventSink {
	write(type: string, data: Record<string, unknown>): Promise<unknown>;
}

export interface JudgeConfig {
	/** DeepSeek API key. Falls back to DEEPSEEK_API_KEY. Never logged. */
	apiKey?: string;
	/** Falls back to DEEPSEEK_MODEL, then "deepseek-v4-pro". */
	model?: string;
	/** Falls back to DEEPSEEK_BASE_URL, then "https://api.deepseek.com". */
	baseUrl?: string;
	timeoutMs?: number;
	maxTokens?: number;
	/** Delay before the single retry on 5xx/timeout/network failure. */
	retryDelayMs?: number;
	/**
	 * Approval hook (spec §11 ask-before-network): called with a redacted
	 * request description before the network call; return false to deny.
	 * Absent = already approved by the harness permission chain.
	 */
	confirm?: (req: JudgeRequestInfo) => boolean | Promise<boolean>;
	/** Optional journal sink — every verdict (and error) is journaled. */
	journal?: JudgeEventSink;
}

export interface Judge {
	/** Permission-chain metadata: this service makes network calls. */
	readonly requiresNetwork: true;
	readonly model: string;
	readonly baseUrl: string;
	judgeFinding(
		reported: Finding,
		expected: ExpectedBug,
		codeContext: string,
	): Promise<JudgeVerdict>;
}

export type JudgeErrorReason =
	| "config"
	| "denied"
	| "http"
	| "timeout"
	| "network"
	| "parse";

export class JudgeError extends Error {
	readonly reason: JudgeErrorReason;
	readonly status?: number;

	constructor(reason: JudgeErrorReason, message: string, status?: number) {
		super(message);
		this.name = "JudgeError";
		this.reason = reason;
		this.status = status;
	}
}

/**
 * The judge() user prompt — near-verbatim port of the Python f-string.
 * `reportedFindings` is a list in the Python; judgeFinding passes exactly one.
 */
export function buildJudgePrompt(
	expectedTitle: string,
	expectedSeverity: string,
	reportedFindings: { severity: string; title: string }[],
	context: string,
): string {
	const findingsText = reportedFindings
		.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}`)
		.join("\n");
	return `You are a senior smart-contract security judge. You are given:

CONTRACT / CONTEXT (possibly truncated):
\`\`\`
${context.slice(0, MAX_CONTEXT_CHARS)}
\`\`\`

GROUND-TRUTH BUG (the expected finding):
- [${expectedSeverity}] ${expectedTitle}

FINDINGS REPORTED BY A MODEL:
${findingsText}

For EACH reported finding, decide exactly one verdict:
- "same": it describes the SAME root cause as the ground-truth bug, even with different wording, location granularity, or framing.
- "valid": it is a DIFFERENT bug but genuinely present and exploitable given the code/context above.
- "invalid": it is hallucinated, not supported by the code/context, or a non-issue.

Be strict about "valid": only use it when the code/context clearly supports the bug. When unsure, choose "invalid".

Return ONLY JSON:
{"verdicts": [{"index": 1, "verdict": "same|valid|invalid", "reason": "<=20 words"}]}`;
}

const VALID_VERDICTS = new Set<string>(["same", "valid", "invalid"]);

/**
 * Python parse_verdicts: tolerant of wrapper text (fenced JSON) and bad rows.
 * Returns the in-range verdicts; [] when nothing usable came back.
 */
export function parseJudgeVerdicts(content: string, nFindings: number): ParsedVerdict[] {
	const start = content.indexOf("{");
	const end = content.lastIndexOf("}");
	if (start === -1 || end <= start) return [];
	let data: unknown;
	try {
		data = JSON.parse(content.slice(start, end + 1));
	} catch {
		return [];
	}
	const rows = (data as { verdicts?: unknown }).verdicts;
	if (!Array.isArray(rows)) return [];
	const out: ParsedVerdict[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const v = row as Record<string, unknown>;
		const rawIdx = v.index ?? 0;
		const idx =
			typeof rawIdx === "string" ? Number.parseInt(rawIdx, 10) : Math.trunc(Number(rawIdx));
		const verdict = String(v.verdict ?? "").toLowerCase().trim();
		if (!Number.isFinite(idx) || !VALID_VERDICTS.has(verdict)) continue;
		if (idx < 1 || idx > nFindings) continue;
		out.push({
			index: idx,
			verdict: verdict as JudgeVerdictKind,
			reason: String(v.reason ?? "").slice(0, 200),
		});
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create the judge. Throws JudgeError("config") when no API key is available.
 * The key is held in the closure only — it appears in the Authorization
 * header and nowhere else.
 */
export function createJudge(config: JudgeConfig = {}): Judge {
	const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
	if (!apiKey) {
		throw new JudgeError(
			"config",
			"DEEPSEEK_API_KEY not set. Add it to .env or export it.",
		);
	}
	const model = config.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_JUDGE_MODEL;
	const baseUrl = (
		config.baseUrl ??
		process.env.DEEPSEEK_BASE_URL ??
		DEFAULT_JUDGE_BASE_URL
	).replace(/\/$/, "");
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
	const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

	// Defensive scrub: an error body (or a misbehaving proxy) must never
	// propagate the key into a thrown error or the journal.
	const scrub = (s: string) => s.split(apiKey).join("***");

	async function postChat(userPrompt: string): Promise<string> {
		const payload = {
			model,
			messages: [
				{ role: "system", content: JUDGE_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			temperature: 0,
			max_tokens: maxTokens,
			stream: false,
			response_format: { type: "json_object" },
			thinking: { type: "disabled" },
		};
		let lastErr: JudgeError | null = null;
		// One retry on 5xx / timeout / network failure (Python retries 3× on any
		// error; the harness policy is a single retry). 4xx fails immediately.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (attempt > 0) await sleep(retryDelayMs);
			let resp: Response;
			try {
				resp = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (e) {
				const timedOut =
					e instanceof DOMException &&
					(e.name === "TimeoutError" || e.name === "AbortError");
				lastErr = new JudgeError(
					timedOut ? "timeout" : "network",
					scrub(
						timedOut
							? `DeepSeek API timeout after ${timeoutMs}ms`
							: `DeepSeek API request failed: ${e instanceof Error ? e.message : String(e)}`,
					),
				);
				continue;
			}
			if (!resp.ok) {
				const bodyText = scrub((await resp.text().catch(() => "")).slice(0, 500));
				lastErr = new JudgeError(
					"http",
					`DeepSeek API error ${resp.status}: ${bodyText}`,
					resp.status,
				);
				if (resp.status >= 500) continue;
				throw lastErr;
			}
			const data = (await resp.json().catch(() => null)) as {
				choices?: { message?: { content?: string } }[];
			} | null;
			return data?.choices?.[0]?.message?.content ?? "";
		}
		throw lastErr!;
	}

	async function judgeFinding(
		reported: Finding,
		expected: ExpectedBug,
		codeContext: string,
	): Promise<JudgeVerdict> {
		// Python: (ex.get("expected_findings") or ["(unknown)"])[0]
		const expectedTitle = expected.title || "(unknown)";
		if (config.confirm) {
			const allowed = await config.confirm({
				kind: "judge_semantic",
				model,
				baseUrl,
				reportedTitle: reported.title,
				expectedTitle,
				contextChars: Math.min(codeContext.length, MAX_CONTEXT_CHARS),
			});
			if (!allowed) {
				throw new JudgeError(
					"denied",
					`judge_semantic call denied by confirm hook: ${reported.title}`,
				);
			}
		}
		const started = Date.now();
		try {
			const prompt = buildJudgePrompt(expectedTitle, expected.severity, [reported], codeContext);
			const content = await postChat(prompt);
			const verdict = parseJudgeVerdicts(content, 1).find((v) => v.index === 1);
			if (!verdict) {
				throw new JudgeError(
					"parse",
					`judge returned no usable verdict: ${scrub(content.slice(0, 200))}`,
				);
			}
			const result: JudgeVerdict = { verdict: verdict.verdict, rationale: verdict.reason };
			// Journaling is best-effort — a failing sink must not break eval.
			await config.journal
				?.write("judge_verdict", {
					model,
					verdict: result.verdict,
					rationale: result.rationale,
					reportedTitle: reported.title,
					expectedTitle,
					expectedSeverity: expected.severity,
					latencyMs: Date.now() - started,
				})
				.catch(() => {});
			return result;
		} catch (e) {
			const err =
				e instanceof JudgeError
					? e
					: new JudgeError("network", scrub(e instanceof Error ? e.message : String(e)));
			await config.journal
				?.write("judge_error", {
					model,
					reportedTitle: reported.title,
					expectedTitle,
					reason: err.reason,
					message: err.message,
				})
				.catch(() => {});
			throw err;
		}
	}

	return { requiresNetwork: true, model, baseUrl, judgeFinding };
}
