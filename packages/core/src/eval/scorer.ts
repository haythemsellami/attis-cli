/**
 * @attis/core eval scorer — lexical matching of reported findings against
 * known bugs (spec §8: `score_finding`, harness-side, auto-approved).
 *
 * Port of orgia-llm `data_pipeline/eval/scorer.py` — the eval contract.
 * Overlap heuristics and thresholds are ported exactly (word sets of ≥4
 * chars, title overlap vs body overlap discounted 0.75, match at ≥0.5,
 * "partial" band at ≥0.25) so numbers stay comparable with the Python bench.
 *
 * One deliberate generalization: the Python scores ONE expected bug per eval
 * example (example-level TP/FP/FN/TN). This port accepts N expected bugs per
 * report (repo-scale audits) and counts at finding level. On single-bug and
 * safe examples the counts collapse to the Python numbers, and
 * `classification` is the exact Python rollup either way.
 */
import type { Finding, Severity } from "../findings.js";

/** A known bug the model is expected to report (Python: one eval example). */
export interface ExpectedBug {
	/** Ground-truth title (Python expected_findings[0]). */
	title: string;
	/** Ground-truth severity. "safe" entries are ignored — pass [] for safe examples. */
	severity: Severity | "safe";
	/** Eval-set provenance for per-source metrics (e.g. "ethernaut"). */
	source?: string;
}

export interface ScoreOptions {
	/**
	 * Full model output for the body-overlap check (Python passes the whole
	 * output). Defaults to the concatenated reported finding sections — pass
	 * the raw output for byte-level parity with the Python scorer.
	 */
	body?: string;
	/**
	 * The model's safe verdict (ParseResult.isSafe). Only affects the
	 * no-findings paths, exactly like the Python scorer: gibberish on a safe
	 * example counts FP, silence on a buggy example is a differently-worded FN.
	 * Defaults to `reported.length === 0`.
	 */
	isSafe?: boolean;
	/** Report-level source for safe examples (no expected bug to carry it). */
	source?: string;
}

/** Example-level rollup — identical to the Python score_output flags. */
export type Classification = "TP" | "FP" | "FN" | "TN";

export interface FindingMatch {
	reportedIndex: number;
	expectedIndex: number;
	/** Overlap score that matched, 0–1. */
	score: number;
	/** Strict per-pair check: the matched finding carries the bug's severity. */
	severityCorrect: boolean;
}

export interface UnmatchedReported {
	reportedIndex: number;
	/** Best overlap against any expected bug, 0–1. ≥0.25 is the "partial" band. */
	bestOverlap: number;
}

export interface SeverityMetrics {
	/** Expected bugs at this severity (1 for a safe example). */
	total: number;
	tp: number;
	fp: number;
	fn: number;
	precision: number;
	recall: number;
	f1: number;
}

export interface SourceMetrics {
	total: number;
	tp: number;
	fp: number;
	fn: number;
	tn: number;
}

export interface ScoreResult {
	/** Example-level rollup, identical to the Python score_output flags. */
	classification: Classification;
	/** Python severity_correct (loose: expected severity present in ANY reported finding). */
	severityCorrect: boolean;
	/** Python finding_matched. */
	findingMatched: boolean;
	/** Human-readable explanation (mirrors the Python detail strings). */
	detail: string;

	/** Finding-level counts (== example-level 0/1 on single-bug examples). */
	tp: number;
	fp: number;
	fn: number;
	tn: number;

	matches: FindingMatch[];
	/** Expected-bug indices the model missed (false negatives). */
	unmatchedExpected: number[];
	/** Reported findings matching no expected bug (false positives). */
	unmatchedReported: UnmatchedReported[];

	/** Finding-level precision/recall/F1. */
	precision: number;
	recall: number;
	f1: number;
	/** Share of matched bugs whose severity the model got right (Python severity_accuracy). */
	severityAccuracy: number;

	perSeverity: Partial<Record<Severity | "safe", SeverityMetrics>>;
	perSource: Record<string, SourceMetrics>;
}

const UNKNOWN_SOURCE = "unknown";
const SEVERITY_KEYS = ["Critical", "High", "Medium", "Low", "safe"] as const;

// Python re.findall(r'\w{4,}', s) — \w is Unicode-aware for str patterns.
const WORD_RE = /[\p{L}\p{N}_]{4,}/gu;

function wordSet(s: string): Set<string> {
	return new Set(s.toLowerCase().match(WORD_RE) ?? []);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n;
}

/**
 * Python `_titles_overlap`: does a predicted title match any expected title?
 * Title overlap counts full; body overlap is discounted 0.75 — the model may
 * name the right root cause in the impact/PoC prose with a different title.
 * Returns on the first expected title reaching the 0.5 match threshold.
 */
export function titlesOverlap(
	predicted: string,
	expected: string[],
	body = "",
): { matched: boolean; score: number } {
	if (expected.length === 0 || !predicted) return { matched: false, score: 0 };
	const predWords = wordSet(predicted);
	const bodyWords = wordSet(body || predicted);
	let best = 0;
	for (const exp of expected) {
		const expWords = wordSet(exp);
		if (expWords.size === 0) continue;
		const titleScore = intersectionSize(expWords, predWords) / expWords.size;
		const bodyScore = intersectionSize(expWords, bodyWords) / expWords.size;
		const score = Math.max(titleScore, bodyScore * 0.75);
		if (score > best) best = score;
		if (score >= 0.5) return { matched: true, score };
	}
	return { matched: false, score: best };
}

function prf1(tp: number, fp: number, fn: number) {
	const precision = tp / Math.max(tp + fp, 1);
	const recall = tp / Math.max(tp + fn, 1);
	const f1 = (2 * precision * recall) / Math.max(precision + recall, 1e-10);
	return { precision, recall, f1 };
}

/** Python str(list) repr for detail strings: ['Medium', 'Low']. */
function pyList(items: string[]): string {
	return `[${items.map((s) => `'${s}'`).join(", ")}]`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

type Bug = Omit<ExpectedBug, "severity"> & { severity: Severity };

/**
 * Score one audit report (already parsed into findings) against the known
 * bugs. Safe/negative examples are `expected: []` (Python expected_severity
 * "safe"). Matching is greedy one-to-one in report order per expected bug —
 * the Python single-bug loop applied per bug; a reported finding consumed by
 * one bug cannot also clear another.
 */
export function scoreFindings(
	reported: Finding[],
	expected: ExpectedBug[],
	opts: ScoreOptions = {},
): ScoreResult {
	const bugs: Bug[] = expected.flatMap((b) =>
		b.severity === "safe" ? [] : [{ ...b, severity: b.severity }],
	);
	const body = opts.body ?? reported.map((f) => f.raw).join("\n\n");
	const modelSaysSafe = opts.isSafe ?? reported.length === 0;

	// --- matching (Python: first predicted finding reaching 0.5 wins) ---
	const matches: FindingMatch[] = [];
	const consumed = new Set<number>();
	const bestOverlap = reported.map(() => 0);
	bugs.forEach((bug, e) => {
		for (let r = 0; r < reported.length; r++) {
			if (consumed.has(r)) continue;
			const { matched, score } = titlesOverlap(reported[r].title, [bug.title], body);
			if (matched) {
				matches.push({
					reportedIndex: r,
					expectedIndex: e,
					score,
					severityCorrect: reported[r].severity === bug.severity,
				});
				consumed.add(r);
				break;
			}
			if (score > bestOverlap[r]) bestOverlap[r] = score;
		}
	});

	const matchedExpected = new Set(matches.map((m) => m.expectedIndex));
	const unmatchedExpected = bugs.map((_, e) => e).filter((e) => !matchedExpected.has(e));
	const unmatchedReported: UnmatchedReported[] = reported
		.map((_, r) => r)
		.filter((r) => !consumed.has(r))
		.map((r) => ({ reportedIndex: r, bestOverlap: bestOverlap[r] }));

	const tp = matchedExpected.size;
	const fn = unmatchedExpected.length;
	const fp = unmatchedReported.length;
	const tn = bugs.length === 0 && reported.length === 0 && modelSaysSafe ? 1 : 0;

	// Python severity_correct: expected severity present in ANY predicted finding.
	const sevCorrectCount = matches.filter((m) =>
		reported.some((f) => f.severity === bugs[m.expectedIndex].severity),
	).length;
	const severityCorrect = tp > 0 && sevCorrectCount === tp;

	// --- example-level classification (Python score_output branches) ---
	let classification: Classification;
	let detail: string;
	if (bugs.length === 0) {
		if (tn) {
			classification = "TN";
			detail = "Correctly identified safe code";
		} else {
			classification = "FP";
			detail = `False positive: reported ${reported.length} finding(s) on safe code`;
		}
	} else if (reported.length === 0) {
		classification = "FN";
		detail = modelSaysSafe
			? "False negative: missed a real bug"
			: "No structured findings and didn't declare safe — treated as miss";
	} else if (matches.length > 0) {
		classification = "TP";
		if (bugs.length === 1) {
			detail = severityCorrect
				? `Correctly identified bug with matching severity (${bugs[0].severity})`
				: `Found right bug but severity mismatch: expected ${bugs[0].severity}, got ${pyList(reported.map((f) => f.severity))}`;
		} else {
			detail = `Matched ${tp} of ${bugs.length} expected bug(s), ${fp} unmatched report(s)`;
		}
	} else {
		classification = "FP";
		const best = Math.max(0, ...bestOverlap);
		detail =
			best >= 0.25
				? `Partial title overlap (${pct(best)}) but not a confident match — likely wrong bug`
				: `Reported findings but none match the known bug (best overlap ${pct(best)})`;
	}

	// --- per-severity breakdown (Python key order: C/H/M/L/safe) ---
	type SevKey = (typeof SEVERITY_KEYS)[number];
	const sevTotal = new Map<SevKey, number>();
	const sevTp = new Map<SevKey, number>();
	const sevFp = new Map<SevKey, number>();
	const sevFn = new Map<SevKey, number>();
	const bump = (m: Map<SevKey, number>, k: SevKey, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
	if (bugs.length === 0) {
		bump(sevTotal, "safe");
		if (fp > 0) bump(sevFp, "safe", fp);
	}
	for (const bug of bugs) bump(sevTotal, bug.severity);
	for (const m of matches) bump(sevTp, bugs[m.expectedIndex].severity);
	for (const e of unmatchedExpected) bump(sevFn, bugs[e].severity);
	for (const u of unmatchedReported) bump(sevFp, reported[u.reportedIndex].severity);

	const perSeverity: Partial<Record<SevKey, SeverityMetrics>> = {};
	for (const sev of SEVERITY_KEYS) {
		const total = sevTotal.get(sev) ?? 0;
		const sFp = sevFp.get(sev) ?? 0;
		if (total === 0 && sFp === 0) continue;
		const sTp = sevTp.get(sev) ?? 0;
		const sFn = sevFn.get(sev) ?? 0;
		perSeverity[sev] = { total, tp: sTp, fp: sFp, fn: sFn, ...prf1(sTp, sFp, sFn) };
	}

	// --- per-source breakdown (insertion order, like the Python dicts) ---
	const srcOf = (bug: Bug) => bug.source ?? opts.source ?? UNKNOWN_SOURCE;
	const reportSources = new Set(bugs.map(srcOf));
	const reportSource =
		reportSources.size === 1
			? [...reportSources][0]
			: (opts.source ?? UNKNOWN_SOURCE);
	const perSource: Record<string, SourceMetrics> = {};
	const srcEntry = (src: string) =>
		(perSource[src] ??= { total: 0, tp: 0, fp: 0, fn: 0, tn: 0 });
	if (bugs.length === 0) {
		const e = srcEntry(opts.source ?? UNKNOWN_SOURCE);
		e.total += 1;
		if (tn) e.tn += 1;
		else e.fp += fp;
	}
	for (const bug of bugs) srcEntry(srcOf(bug)).total += 1;
	for (const m of matches) srcEntry(srcOf(bugs[m.expectedIndex])).tp += 1;
	for (const e of unmatchedExpected) srcEntry(srcOf(bugs[e])).fn += 1;
	if (bugs.length > 0) srcEntry(reportSource).fp += fp;

	return {
		classification,
		severityCorrect,
		findingMatched: matches.length > 0,
		detail,
		tp,
		fp,
		fn,
		tn,
		matches,
		unmatchedExpected,
		unmatchedReported,
		...prf1(tp, fp, fn),
		severityAccuracy: sevCorrectCount / Math.max(tp, 1),
		perSeverity,
		perSource,
	};
}
