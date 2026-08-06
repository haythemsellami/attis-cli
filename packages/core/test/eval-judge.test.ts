/**
 * Tests for the DeepSeek semantic judge. Endpoint is always a stubbed fetch —
 * no real API calls. Key hygiene is asserted explicitly: the key rides in the
 * Authorization header and must appear in nothing logged, journaled, or thrown.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Finding } from "../src/findings.js";
import type { ExpectedBug } from "../src/eval/scorer.js";
import {
	buildJudgePrompt,
	createJudge,
	JUDGE_SYSTEM_PROMPT,
	JudgeError,
	parseJudgeVerdicts,
	type JudgeRequestInfo,
} from "../src/eval/judge.js";

const KEY = "sk-test-secret-123";
const CFG = { apiKey: KEY, model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", retryDelayMs: 0 };

const REPORTED: Finding = {
	severity: "High",
	title: "Reentrancy in withdraw()",
	raw: "### [High] Reentrancy in withdraw()",
};
const EXPECTED: ExpectedBug = {
	title: "Reentrancy in withdraw()",
	severity: "High",
	source: "ethernaut",
};

const verdictBody = (verdict: string, reason = "same root cause") =>
	JSON.stringify({ verdicts: [{ index: 1, verdict, reason }] });

const okResponse = (verdict: string, reason?: string) =>
	new Response(
		JSON.stringify({ choices: [{ message: { content: verdictBody(verdict, reason) } }] }),
		{ status: 200 },
	);

function stubFetchSeq(responses: (Response | (() => Response))[]) {
	const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls.push({ url, init, body: JSON.parse(String(init.body)) });
		const next = responses[Math.min(calls.length - 1, responses.length - 1)];
		if (typeof next === "function") return next();
		return next;
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("createJudge config", () => {
	it("throws a clear config error when the API key is missing", () => {
		vi.stubEnv("DEEPSEEK_API_KEY", "");
		expect(() => createJudge()).toThrowError(JudgeError);
		try {
			createJudge();
		} catch (e) {
			expect((e as JudgeError).reason).toBe("config");
			expect((e as JudgeError).message).toContain("DEEPSEEK_API_KEY not set");
		}
	});

	it("reads model/baseUrl/key from env, strips trailing slash", () => {
		vi.stubEnv("DEEPSEEK_API_KEY", KEY);
		vi.stubEnv("DEEPSEEK_MODEL", "env-model");
		vi.stubEnv("DEEPSEEK_BASE_URL", "https://example.test/");
		const judge = createJudge();
		expect(judge.model).toBe("env-model");
		expect(judge.baseUrl).toBe("https://example.test");
		expect(judge.requiresNetwork).toBe(true);
	});

	it("exposes no apiKey on the judge object", () => {
		const judge = createJudge(CFG);
		expect(Object.keys(judge).sort()).toEqual(
			["baseUrl", "judgeFinding", "model", "requiresNetwork"].sort(),
		);
	});
});

describe("judgeFinding — verdicts", () => {
	it.each(["same", "valid", "invalid"] as const)("parses verdict %s", async (verdict) => {
		stubFetchSeq([okResponse(verdict)]);
		const judge = createJudge(CFG);
		const r = await judge.judgeFinding(REPORTED, EXPECTED, "contract Vault {}");
		expect(r.verdict).toBe(verdict);
		expect(r.rationale).toBe("same root cause");
	});

	it("tolerates fenced JSON wrapper text", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { content: "```json\n" + verdictBody("valid") + "\n```" } },
						],
					}),
					{ status: 200 },
				),
		);
		const judge = createJudge(CFG);
		const r = await judge.judgeFinding(REPORTED, EXPECTED, "code");
		expect(r.verdict).toBe("valid");
	});

	it("rejects with a parse error on malformed judge output", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({ choices: [{ message: { content: "I think it is same" } }] }),
					{ status: 200 },
				),
		);
		const judge = createJudge(CFG);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			name: "JudgeError",
			reason: "parse",
		});
	});

	it("rejects with a parse error when the verdict index is out of range", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						choices: [
							{ message: { content: JSON.stringify({ verdicts: [{ index: 2, verdict: "same", reason: "x" }] }) } },
						],
					}),
					{ status: 200 },
				),
		);
		const judge = createJudge(CFG);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "parse",
		});
	});
});

describe("judgeFinding — request shape (prompt ported near-verbatim)", () => {
	it("sends the Python payload shape and prompt", async () => {
		const calls = stubFetchSeq([okResponse("same")]);
		const judge = createJudge(CFG);
		await judge.judgeFinding(REPORTED, EXPECTED, "contract Vault {}");

		expect(calls).toHaveLength(1);
		const { url, init, body } = calls[0];
		expect(url).toBe("https://api.deepseek.com/chat/completions");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
		expect(body.model).toBe("deepseek-v4-pro");
		expect(body.temperature).toBe(0);
		expect(body.max_tokens).toBe(1024);
		expect(body.stream).toBe(false);
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.thinking).toEqual({ type: "disabled" });

		const messages = body.messages as { role: string; content: string }[];
		expect(messages[0]).toEqual({ role: "system", content: JUDGE_SYSTEM_PROMPT });
		const prompt = messages[1].content;
		expect(prompt).toContain("You are a senior smart-contract security judge.");
		expect(prompt).toContain("GROUND-TRUTH BUG (the expected finding):");
		expect(prompt).toContain("- [High] Reentrancy in withdraw()");
		expect(prompt).toContain("FINDINGS REPORTED BY A MODEL:\n1. [High] Reentrancy in withdraw()");
		expect(prompt).toContain('"same": it describes the SAME root cause');
		expect(prompt).toContain('"valid": it is a DIFFERENT bug');
		expect(prompt).toContain('"invalid": it is hallucinated');
		expect(prompt).toContain('Be strict about "valid"');
		expect(prompt).toContain(
			'Return ONLY JSON:\n{"verdicts": [{"index": 1, "verdict": "same|valid|invalid", "reason": "<=20 words"}]}',
		);
	});

	it("truncates the code context at 8000 chars (Python MAX_CONTEXT_CHARS)", async () => {
		const calls = stubFetchSeq([okResponse("same")]);
		const judge = createJudge(CFG);
		await judge.judgeFinding(REPORTED, EXPECTED, "x".repeat(9000));
		const messages = (calls[0].body.messages as { content: string }[]);
		expect(messages[1].content).toContain("x".repeat(8000));
		expect(messages[1].content).not.toContain("x".repeat(8001));
	});
});

describe("judgeFinding — retry, timeout, errors", () => {
	it("retries once on 5xx and succeeds", async () => {
		const calls = stubFetchSeq([new Response("boom", { status: 500 }), okResponse("valid")]);
		const judge = createJudge(CFG);
		const r = await judge.judgeFinding(REPORTED, EXPECTED, "code");
		expect(r.verdict).toBe("valid");
		expect(calls).toHaveLength(2);
	});

	it("fails after the single retry when 5xx persists", async () => {
		const calls = stubFetchSeq([new Response("boom", { status: 500 })]);
		const judge = createJudge(CFG);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "http",
			status: 500,
		});
		expect(calls).toHaveLength(2);
	});

	it("does not retry on 4xx", async () => {
		const calls = stubFetchSeq([new Response("unauthorized", { status: 401 })]);
		const judge = createJudge(CFG);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "http",
			status: 401,
		});
		expect(calls).toHaveLength(1);
	});

	it("times out and retries once", async () => {
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					calls++;
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("The operation timed out.", "TimeoutError")),
					);
				}),
		);
		const judge = createJudge({ ...CFG, timeoutMs: 20 });
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "timeout",
		});
		expect(calls).toBe(2);
	});

	it("classifies network failures and retries once", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw new TypeError("fetch failed");
		});
		const judge = createJudge(CFG);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "network",
		});
		expect(calls).toBe(2);
	});
});

describe("judgeFinding — approval hook + journal", () => {
	it("requiresNetwork metadata is set for the permission chain", () => {
		expect(createJudge(CFG).requiresNetwork).toBe(true);
	});

	it("confirm=false denies the call before any network request", async () => {
		let fetchCalls = 0;
		vi.stubGlobal("fetch", async () => {
			fetchCalls++;
			return okResponse("same");
		});
		const seen: JudgeRequestInfo[] = [];
		const judge = createJudge({
			...CFG,
			confirm: (req) => {
				seen.push(req);
				return false;
			},
		});
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "denied",
		});
		expect(fetchCalls).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			kind: "judge_semantic",
			model: "deepseek-v4-pro",
			baseUrl: "https://api.deepseek.com",
			reportedTitle: REPORTED.title,
			expectedTitle: EXPECTED.title,
			contextChars: 4,
		});
	});

	it("confirm=true lets the call through", async () => {
		stubFetchSeq([okResponse("same")]);
		const judge = createJudge({ ...CFG, confirm: () => true });
		const r = await judge.judgeFinding(REPORTED, EXPECTED, "code");
		expect(r.verdict).toBe("same");
	});

	it("journals verdicts and errors to the sink", async () => {
		const writes: { type: string; data: Record<string, unknown> }[] = [];
		const journal = {
			write: async (type: string, data: Record<string, unknown>) => {
				writes.push({ type, data });
			},
		};
		stubFetchSeq([okResponse("valid", "a real different bug")]);
		const judge = createJudge({ ...CFG, journal });
		await judge.judgeFinding(REPORTED, EXPECTED, "code");
		expect(writes).toHaveLength(1);
		expect(writes[0].type).toBe("judge_verdict");
		expect(writes[0].data).toMatchObject({
			verdict: "valid",
			rationale: "a real different bug",
			reportedTitle: REPORTED.title,
			expectedTitle: EXPECTED.title,
			expectedSeverity: "High",
		});

		writes.length = 0;
		stubFetchSeq([new Response("boom", { status: 500 })]);
		await expect(judge.judgeFinding(REPORTED, EXPECTED, "code")).rejects.toMatchObject({
			reason: "http",
		});
		expect(writes).toHaveLength(1);
		expect(writes[0].type).toBe("judge_error");
		expect(writes[0].data).toMatchObject({ reason: "http" });
	});
});

describe("API key hygiene", () => {
	it("the key never appears in thrown errors, results, or journal writes", async () => {
		const writes: unknown[] = [];
		const journal = {
			write: async (_type: string, data: Record<string, unknown>) => {
				writes.push(data);
			},
		};
		// The (toxic) endpoint echoes the key in its error body. Factory form:
		// each attempt gets a fresh Response (a consumed body can't be re-read).
		stubFetchSeq([() => new Response(`{"error": "bad key ${KEY}"}`, { status: 500 })]);
		const judge = createJudge({ ...CFG, journal });
		const err = await judge.judgeFinding(REPORTED, EXPECTED, "code").catch((e) => e);
		expect(err).toBeInstanceOf(JudgeError);
		expect((err as JudgeError).message).not.toContain(KEY);
		expect((err as JudgeError).message).toContain("***");
		expect(JSON.stringify(writes)).not.toContain(KEY);

		// Success path: the result object carries no key either.
		stubFetchSeq([okResponse("same")]);
		const r = await judge.judgeFinding(REPORTED, EXPECTED, "code");
		expect(JSON.stringify(r)).not.toContain(KEY);
	});
});

describe("parseJudgeVerdicts (Python parse_verdicts)", () => {
	it("parses, lowercases, and bounds-checks rows", () => {
		const content = JSON.stringify({
			verdicts: [
				{ index: 1, verdict: "SAME", reason: "ok" },
				{ index: 3, verdict: "valid", reason: "out of range" },
				{ index: 2, verdict: "maybe", reason: "bad verdict" },
				{ index: "x", verdict: "invalid", reason: "bad index" },
			],
		});
		expect(parseJudgeVerdicts(content, 2)).toEqual([
			{ index: 1, verdict: "same", reason: "ok" },
		]);
	});

	it("truncates reasons to 200 chars", () => {
		const content = JSON.stringify({
			verdicts: [{ index: 1, verdict: "same", reason: "r".repeat(250) }],
		});
		expect(parseJudgeVerdicts(content, 1)[0].reason).toHaveLength(200);
	});

	it("returns [] on garbage, missing verdicts, or wrong shapes", () => {
		expect(parseJudgeVerdicts("not json", 1)).toEqual([]);
		expect(parseJudgeVerdicts('{"other": 1}', 1)).toEqual([]);
		expect(parseJudgeVerdicts('{"verdicts": "nope"}', 1)).toEqual([]);
		expect(parseJudgeVerdicts("", 1)).toEqual([]);
	});
});

describe("buildJudgePrompt", () => {
	it("numbers reported findings like the Python findings_text", () => {
		const p = buildJudgePrompt(
			"Bug A",
			"High",
			[
				{ severity: "High", title: "First" },
				{ severity: "Low", title: "Second" },
			],
			"code",
		);
		expect(p).toContain("FINDINGS REPORTED BY A MODEL:\n1. [High] First\n2. [Low] Second");
		expect(p).toContain("- [High] Bug A");
	});
});
