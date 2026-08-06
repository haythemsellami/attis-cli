/**
 * Tests for the eval scorer. Fixtures are hand-derived from orgia-llm
 * scorer.py's documented behavior (word sets of ≥4 chars, title overlap vs
 * body overlap discounted 0.75, match ≥0.5, partial band ≥0.25). Synthetic
 * findings only — eval data never crosses into this repo (AGENTS.md).
 */
import { describe, expect, it } from "vitest";
import { parseFindings, type Finding } from "../src/findings.js";
import {
	scoreFindings,
	titlesOverlap,
	type ExpectedBug,
} from "../src/eval/scorer.js";

const finding = (severity: Finding["severity"], title: string, raw?: string): Finding => ({
	severity,
	title,
	raw: raw ?? `### [${severity}] ${title}`,
});

describe("titlesOverlap (Python _titles_overlap)", () => {
	it("exact title match scores 1.0", () => {
		expect(titlesOverlap("Reentrancy in withdraw()", ["Reentrancy in withdraw()"]))
			.toEqual({ matched: true, score: 1 });
	});

	it("matches at exactly the 0.5 threshold", () => {
		// exp {aaaa,bbbb,cccc,dddd}; pred shares 2/4 = 0.5
		expect(titlesOverlap("aaaa bbbb", ["aaaa bbbb cccc dddd"]).matched).toBe(true);
	});

	it("does not match below 0.5", () => {
		// 1/4 = 0.25
		const r = titlesOverlap("aaaa", ["aaaa bbbb cccc dddd"]);
		expect(r.matched).toBe(false);
		expect(r.score).toBe(0.25);
	});

	it("body overlap counts at 0.75 discount — 2/3 in body = exactly 0.5", () => {
		const r = titlesOverlap("Unrelated title here", ["aaaa bbbb cccc"], "aaaa bbbb xxxx");
		expect(r.matched).toBe(true);
		expect(r.score).toBe(0.5);
	});

	it("ignores words shorter than 4 chars and empty expected lists", () => {
		expect(titlesOverlap("bug in fn", ["bug in fn"])).toEqual({ matched: false, score: 0 });
		expect(titlesOverlap("anything", [])).toEqual({ matched: false, score: 0 });
		expect(titlesOverlap("", ["aaaa bbbb"])).toEqual({ matched: false, score: 0 });
	});
});

describe("scoreFindings — example-level classification (Python score_output)", () => {
	const reentrancy: ExpectedBug = {
		title: "Reentrancy in withdraw()",
		severity: "High",
		source: "ethernaut",
	};

	it("TP: exact title + matching severity", () => {
		const parsed = parseFindings(
			"### [High] Reentrancy in withdraw()\n\n**Impact:** Attacker drains the vault.",
		);
		const r = scoreFindings(parsed.findings, [reentrancy]);
		expect(r.classification).toBe("TP");
		expect(r.findingMatched).toBe(true);
		expect(r.severityCorrect).toBe(true);
		expect(r.detail).toBe("Correctly identified bug with matching severity (High)");
		expect([r.tp, r.fp, r.fn, r.tn]).toEqual([1, 0, 0, 0]);
		expect(r.precision).toBe(1);
		expect(r.recall).toBe(1);
		expect(r.f1).toBe(1);
		expect(r.severityAccuracy).toBe(1);
		expect(r.matches).toHaveLength(1);
		expect(r.matches[0]).toMatchObject({ reportedIndex: 0, expectedIndex: 0, score: 1 });
	});

	it("TP via paraphrase: body overlap rescues a reworded title", () => {
		// Expected words (≥4 chars): anyone claim ownership contributing then
		// calling fallback receive (8). Title alone covers 3/8 = 0.375; the
		// impact prose covers 8/8 → body 1.0 * 0.75 = 0.75 ≥ 0.5.
		const parsed = parseFindings(
			"### [Medium] Unauthorized ownership takeover via fallback receive()\n\n" +
				"**Impact:** Anyone can claim ownership by contributing a tiny amount, " +
				"then calling the fallback receive path to become owner.",
		);
		const expected: ExpectedBug = {
			title: "Anyone can claim ownership by contributing then calling fallback receive()",
			severity: "High",
			source: "ethernaut",
		};
		const r = scoreFindings(parsed.findings, [expected]);
		expect(r.classification).toBe("TP");
		expect(r.matches[0].score).toBeCloseTo(0.75);
		// Python severity_correct: expected severity absent from ALL reported findings
		expect(r.severityCorrect).toBe(false);
		expect(r.detail).toBe(
			"Found right bug but severity mismatch: expected High, got ['Medium']",
		);
		expect(r.severityAccuracy).toBe(0);
	});

	it("FN: model said safe on a buggy example", () => {
		const parsed = parseFindings("No issues found.\n\nChecks are in place.");
		const r = scoreFindings(parsed.findings, [reentrancy], { isSafe: parsed.isSafe });
		expect(r.classification).toBe("FN");
		expect(r.detail).toBe("False negative: missed a real bug");
		expect([r.tp, r.fp, r.fn, r.tn]).toEqual([0, 0, 1, 0]);
	});

	it("FN: gibberish output on a buggy example gets the no-findings detail", () => {
		const r = scoreFindings([], [reentrancy], { isSafe: false });
		expect(r.classification).toBe("FN");
		expect(r.detail).toBe("No structured findings and didn't declare safe — treated as miss");
	});

	it("FP: findings reported on a safe example (expected: [])", () => {
		const parsed = parseFindings("### [High] Reentrancy in withdraw()\n\n**Impact:** x");
		const r = scoreFindings(parsed.findings, [], { source: "c4_safe" });
		expect(r.classification).toBe("FP");
		expect(r.detail).toBe("False positive: reported 1 finding(s) on safe code");
		expect([r.tp, r.fp, r.fn, r.tn]).toEqual([0, 1, 0, 0]);
		// Python attributes the FP to the "safe" severity bucket
		expect(r.perSeverity.safe).toMatchObject({ total: 1, tp: 0, fp: 1, fn: 0 });
		expect(r.perSource.c4_safe).toMatchObject({ total: 1, fp: 1, tn: 0 });
	});

	it("TN: safe example, no findings", () => {
		const r = scoreFindings([], [], { isSafe: true, source: "c4_safe" });
		expect(r.classification).toBe("TN");
		expect(r.detail).toBe("Correctly identified safe code");
		expect([r.tp, r.fp, r.fn, r.tn]).toEqual([0, 0, 0, 1]);
		expect(r.perSeverity.safe).toMatchObject({ total: 1, tp: 0, fp: 0, fn: 0 });
		expect(r.perSource.c4_safe).toMatchObject({ total: 1, tn: 1 });
	});

	it("FP: gibberish on a safe example (Python parity via isSafe: false)", () => {
		const r = scoreFindings([], [], { isSafe: false });
		expect(r.classification).toBe("FP");
		expect(r.detail).toBe("False positive: reported 0 finding(s) on safe code");
	});

	it("FP: reported findings but none match the known bug", () => {
		const parsed = parseFindings(
			"### [Medium] Missing zero-address check in setOwner\n\n" +
				"**Impact:** Ownership can be lost permanently.",
		);
		const r = scoreFindings(parsed.findings, [reentrancy]);
		expect(r.classification).toBe("FP");
		expect(r.findingMatched).toBe(false);
		expect(r.detail).toBe(
			"Reported findings but none match the known bug (best overlap 0%)",
		);
		expect(r.unmatchedReported).toEqual([{ reportedIndex: 0, bestOverlap: 0 }]);
		// Finding-level counts: the missed bug is FN, the wrong finding is FP
		expect([r.tp, r.fp, r.fn]).toEqual([0, 1, 1]);
		expect(r.perSeverity.High).toMatchObject({ total: 1, tp: 0, fn: 1 });
		expect(r.perSeverity.Medium).toMatchObject({ total: 0, fp: 1 });
	});

	it("FP: partial overlap (0.25–0.5) gets the 'partial' detail", () => {
		// exp {oracle, manipulation, stale, price}; title shares only "stale" = 1/4
		const parsed = parseFindings(
			"### [Low] Stale block timestamp used in auction\n\n" +
				"**Impact:** Bids can be ordered unfairly.",
		);
		const expected: ExpectedBug = {
			title: "Oracle manipulation via stale price",
			severity: "Critical",
			source: "scabench",
		};
		const r = scoreFindings(parsed.findings, [expected]);
		expect(r.classification).toBe("FP");
		expect(r.detail).toBe(
			"Partial title overlap (25%) but not a confident match — likely wrong bug",
		);
		expect(r.unmatchedReported[0].bestOverlap).toBe(0.25);
	});
});

describe("scoreFindings — multi-bug reports + aggregation", () => {
	const bugs: ExpectedBug[] = [
		{ title: "Reentrancy in withdraw()", severity: "High", source: "ethernaut" },
		{ title: "Missing zero-address check in setOwner", severity: "Medium", source: "ethernaut" },
		{ title: "Oracle manipulation via stale price", severity: "Critical", source: "scabench" },
	];
	const reported: Finding[] = [
		finding("High", "Reentrancy in withdraw()", "### [High] Reentrancy in withdraw()\n**Impact:** Attacker drains the vault balance."),
		finding("Low", "Missing zero-address check in setOwner", "### [Low] Missing zero-address check in setOwner\n**Impact:** Ownership can be lost forever."),
		finding("Low", "Unbounded loop over user deposits", "### [Low] Unbounded loop over user deposits\n**Impact:** Gas exhaustion blocks depositors."),
	];

	it("counts finding-level TP/FN/FP across a multi-bug report", () => {
		const r = scoreFindings(reported, bugs);
		expect(r.classification).toBe("TP");
		expect([r.tp, r.fp, r.fn, r.tn]).toEqual([2, 1, 1, 0]);
		expect(r.matches).toHaveLength(2);
		expect(r.matches[0]).toMatchObject({ reportedIndex: 0, expectedIndex: 0, severityCorrect: true });
		expect(r.matches[1]).toMatchObject({ reportedIndex: 1, expectedIndex: 1, severityCorrect: false });
		expect(r.unmatchedExpected).toEqual([2]);
		expect(r.unmatchedReported).toEqual([{ reportedIndex: 2, bestOverlap: 0 }]);
		// precision/recall/f1: tp=2 fp=1 fn=1
		expect(r.precision).toBeCloseTo(2 / 3);
		expect(r.recall).toBeCloseTo(2 / 3);
		expect(r.f1).toBeCloseTo(2 / 3);
		// Python-loose severity check per matched bug: b0's "High" appears among
		// the reported severities, b1's "Medium" does not → 1 of 2.
		expect(r.severityAccuracy).toBeCloseTo(0.5);
		expect(r.severityCorrect).toBe(false);
	});

	it("per-severity breakdown in Python key order", () => {
		const r = scoreFindings(reported, bugs);
		expect(Object.keys(r.perSeverity)).toEqual(["Critical", "High", "Medium", "Low"]);
		expect(r.perSeverity.High).toMatchObject({ total: 1, tp: 1, fp: 0, fn: 0 });
		expect(r.perSeverity.Medium).toMatchObject({ total: 1, tp: 1, fp: 0, fn: 0 });
		expect(r.perSeverity.Critical).toMatchObject({ total: 1, tp: 0, fp: 0, fn: 1 });
		expect(r.perSeverity.Low).toMatchObject({ total: 0, tp: 0, fp: 1, fn: 0 });
		expect(r.perSeverity.Critical!.precision).toBe(0);
		expect(r.perSeverity.High!.f1).toBe(1);
	});

	it("per-source breakdown attributes TP/FN per bug, FP per report", () => {
		const r = scoreFindings(reported, bugs);
		expect(r.perSource.ethernaut).toEqual({ total: 2, tp: 2, fp: 0, fn: 0, tn: 0 });
		expect(r.perSource.scabench).toEqual({ total: 1, tp: 0, fp: 0, fn: 1, tn: 0 });
		// Mixed-source report: unmatched findings can't be attributed → "unknown"
		expect(r.perSource.unknown).toEqual({ total: 0, tp: 0, fp: 1, fn: 0, tn: 0 });
	});

	it("single-source report attributes FPs to that source", () => {
		const r = scoreFindings([reported[0], reported[2]], bugs.slice(0, 2));
		expect(r.perSource.ethernaut).toEqual({ total: 2, tp: 1, fp: 1, fn: 1, tn: 0 });
	});

	it("a reported finding consumed by one bug cannot clear another", () => {
		const dupes = [reported[0], finding("Medium", "Reentrancy in withdraw()")];
		const r = scoreFindings(dupes, [bugs[0]]);
		expect(r.tp).toBe(1);
		expect(r.fp).toBe(1); // the duplicate is an unmatched report
	});
});
