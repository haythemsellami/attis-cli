/**
 * @attis/core findings parser — model output → typed findings.
 *
 * Port of orgia-llm's scorer.parse_model_output semantics, extended to
 * extract report sections (**Impact:**, **Proof of Concept:**,
 * **Remediation:**) per finding — the harness treats `### [Severity]`
 * output as typed data, not prose.
 *
 * Contract: strict by default — output that declares no findings AND is not
 * a safe verdict is flagged `unparseable` (the caller decides; the flywheel
 * must never ingest silent salvage).
 */

export type Severity = "Critical" | "High" | "Medium" | "Low";

export interface Finding {
	severity: Severity;
	title: string;
	impact?: string;
	poc?: string;
	remediation?: string;
	/** Raw text of this finding's section. */
	raw: string;
}

export interface ParseResult {
	findings: Finding[];
	isSafe: boolean;
	/** True when no findings parsed AND no safe verdict — do NOT salvage. */
	unparseable: boolean;
	raw: string;
}

const SAFE_PATTERNS = [
	"no issues found",
	"no issues",
	"no vulnerabilities",
	"no vulnerability",
	"no findings",
	"the code is safe",
	"this contract is safe",
	"no security issues",
];

const SEVERITY_MAP: Record<string, Severity> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	qa: "Low",
	gas: "Low",
	informational: "Low",
	insight: "Low",
	h: "High",
	m: "Medium",
	l: "Low",
};

function normalizeSeverity(raw: string): Severity | null {
	return SEVERITY_MAP[raw.trim().toLowerCase()] ?? null;
}

// ### [High] Title  /  ### [H-01] Title  /  ### [Critical] Title
const FINDING_HEADER_RE =
	/#+\s*\[(Critical|High|Medium|Low|QA|Gas|Informational|Insight|H|M|L)-?\d*\s*\]\s*(.+?)(?:\n|$)/gi;

const SECTION_RE = (label: string) =>
	new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Z][^*]+:\\*\\*|\\n###|$)`, "i");

function extractSection(text: string, label: string): string | undefined {
	const m = SECTION_RE(label).exec(text);
	if (!m) return undefined;
	return m[1].trim() || undefined;
}

/**
 * Parse model output into typed findings.
 * Findings carry their sections; the report-level isSafe mirrors the
 * scorer's no-issue patterns.
 */
export function parseFindings(output: string): ParseResult {
	const raw = output;
	const lower = output.toLowerCase();
	const isSafe = SAFE_PATTERNS.some((p) => lower.includes(p));

	const findings: Finding[] = [];
	const headers = [...output.matchAll(FINDING_HEADER_RE)];

	for (let i = 0; i < headers.length; i++) {
		const m = headers[i];
		const severity = normalizeSeverity(m[1]);
		if (!severity) continue;
		const title = m[2].trim().replace(/\*+$/, "").trim();
		const start = m.index! + m[0].length;
		const end = i + 1 < headers.length ? headers[i + 1].index! : output.length;
		const section = output.slice(start, end).trim();

		findings.push({
			severity,
			title,
			impact: extractSection(section, "Impact"),
			poc: extractSection(section, "Proof of Concept"),
			remediation: extractSection(section, "Remediation"),
			raw: `${m[0].trim()}\n${section}`.trim(),
		});
	}

	return {
		findings,
		isSafe,
		unparseable: findings.length === 0 && !isSafe,
		raw,
	};
}
