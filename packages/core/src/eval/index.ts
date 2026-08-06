/**
 * Harness-side judge + scorer services (roadmap v2 item 6, spec §8).
 * Scorer is local and auto-approved; the judge is network-gated
 * (`requiresNetwork`, ask-before-network per spec §11).
 */
export { scoreFindings, titlesOverlap } from "./scorer.js";
export type {
	Classification,
	ExpectedBug,
	FindingMatch,
	ScoreOptions,
	ScoreResult,
	SeverityMetrics,
	SourceMetrics,
	UnmatchedReported,
} from "./scorer.js";
export {
	buildJudgePrompt,
	createJudge,
	DEFAULT_JUDGE_BASE_URL,
	DEFAULT_JUDGE_MODEL,
	JUDGE_SYSTEM_PROMPT,
	JudgeError,
	parseJudgeVerdicts,
} from "./judge.js";
export type {
	Judge,
	JudgeConfig,
	JudgeErrorReason,
	JudgeEventSink,
	JudgeRequestInfo,
	JudgeVerdict,
	JudgeVerdictKind,
	ParsedVerdict,
} from "./judge.js";
