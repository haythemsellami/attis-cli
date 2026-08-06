/**
 * execpolicy — declarative gating at the executor chokepoint (spec §6/§11,
 * codex-style: declarative + self-testing).
 *
 * Rules load from policy/execpolicy.json:
 *   [{ "prefix": ["cast", "send", "--private-key"],
 *      "decision": "forbidden",
 *      "examples": { "positive": [...argv...], "negative": [...argv...] } }, ...]
 *
 * - Prefix matching: argv must start with the pattern; "*" matches any
 *   single token. First matching rule wins; default decision is "prompt".
 * - Self-test on load: every rule carries a positive/negative argv pair;
 *   the positive must match the rule's prefix (and decide to the rule's
 *   decision under first-match-wins), the negative must not match. Any
 *   failure throws — a broken policy must fail closed at startup, not
 *   silently gate nothing.
 *
 * HONEST SCOPE NOTE: scanCode() is a best-effort static scan of Python
 * source for forbidden literals — it catches the obvious cases
 * (`--private-key`, `curl`, `wget`, `requests.`, `socket.`) but it is
 * trivially evadable by construction ("so" + "cket."). It is a tripwire,
 * not a boundary: the docker executor driver (deferred, triggers in
 * spec §6) is the future hard network/exec boundary.
 */
import { readFileSync } from "node:fs";

export type PolicyDecision = "allow" | "prompt" | "forbidden";

export const DEFAULT_DECISION: PolicyDecision = "prompt";

export interface PolicyRule {
	prefix: string[];
	decision: PolicyDecision;
	examples: { positive: string[]; negative: string[] };
}

export interface ScanHit {
	literal: string;
	line: number;
}

export interface CodeScan {
	decision: PolicyDecision;
	hits: ScanHit[];
}

export interface Policy {
	rules: PolicyRule[];
	checkCommand(argv: string[]): PolicyDecision;
	scanCode(code: string): CodeScan;
}

export class PolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyError";
	}
}

/** Literals forbidden in kernel-executed Python code (see scope note above). */
export const FORBIDDEN_CODE_LITERALS: readonly { literal: string; re: RegExp }[] = [
	{ literal: "--private-key", re: /--private-key/ },
	{ literal: "curl", re: /\bcurl\b/ },
	{ literal: "wget", re: /\bwget\b/ },
	{ literal: "requests.", re: /\brequests\./ },
	{ literal: "socket.", re: /\bsocket\./ },
];

const DECISIONS = new Set<PolicyDecision>(["allow", "prompt", "forbidden"]);

function prefixMatches(prefix: string[], argv: string[]): boolean {
	if (argv.length < prefix.length) return false;
	return prefix.every((tok, i) => tok === "*" || tok === argv[i]);
}

export function scanCode(code: string): CodeScan {
	const hits: ScanHit[] = [];
	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		for (const { literal, re } of FORBIDDEN_CODE_LITERALS) {
			if (re.test(lines[i])) hits.push({ literal, line: i + 1 });
		}
	}
	return { decision: hits.length > 0 ? "forbidden" : "allow", hits };
}

export function loadPolicy(path: string): Policy {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		throw new PolicyError(`execpolicy unreadable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(raw)) {
		throw new PolicyError(`execpolicy at ${path} must be a JSON array of rules`);
	}
	const rules: PolicyRule[] = raw.map((entry, i) => {
		const r = entry as Partial<PolicyRule>;
		if (!Array.isArray(r.prefix) || !r.prefix.every((t) => typeof t === "string")) {
			throw new PolicyError(`rule ${i}: prefix must be a string array`);
		}
		if (!r.decision || !DECISIONS.has(r.decision)) {
			throw new PolicyError(`rule ${i}: decision must be allow|prompt|forbidden`);
		}
		if (
			!r.examples ||
			!Array.isArray(r.examples.positive) ||
			!Array.isArray(r.examples.negative)
		) {
			throw new PolicyError(`rule ${i}: examples.{positive,negative} argv arrays are required (self-test)`);
		}
		return r as PolicyRule;
	});

	const policy: Policy = {
		rules,
		checkCommand(argv: string[]): PolicyDecision {
			for (const rule of rules) {
				if (prefixMatches(rule.prefix, argv)) return rule.decision;
			}
			return DEFAULT_DECISION;
		},
		scanCode,
	};

	// Self-test (codex-style): a rule whose examples don't behave as
	// declared means the file is lying — refuse to load it.
	for (const [i, rule] of rules.entries()) {
		const label = `rule ${i} (${JSON.stringify(rule.prefix)} → ${rule.decision})`;
		if (!prefixMatches(rule.prefix, rule.examples.positive)) {
			throw new PolicyError(`execpolicy self-test failed: ${label} does not match its positive example`);
		}
		if (prefixMatches(rule.prefix, rule.examples.negative)) {
			throw new PolicyError(`execpolicy self-test failed: ${label} matches its negative example`);
		}
		const decided = policy.checkCommand(rule.examples.positive);
		if (decided !== rule.decision) {
			throw new PolicyError(
				`execpolicy self-test failed: ${label} positive example decides "${decided}" (shadowed by an earlier rule?)`,
			);
		}
	}
	return policy;
}
