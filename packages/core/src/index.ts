export { createAuditAgent, AUDITOR_SYSTEM_PROMPT } from "./agent.js";
export type { AuditAgentOptions } from "./agent.js";
export { createForkVerifyTool } from "./tools/fork-verify.js";
export { parseFindings } from "./findings.js";
export type { Finding, ParseResult, Severity } from "./findings.js";
export { createGeneratePocTool, EXPLOIT_SYSTEM_PROMPT, buildPocUserPrompt } from "./tools/generate-poc.js";
export { createExecuteCodeTool } from "./tools/execute-code.js";
export type { ExecuteCodeDeps, ExecuteCodeTool, ExecutionMeta } from "./tools/execute-code.js";
export { scoreFindings, titlesOverlap, createJudge, JudgeError } from "./eval/index.js";
export type { ExpectedBug, ScoreResult, Judge, JudgeConfig, JudgeVerdict } from "./eval/index.js";
export { runAuditLoop } from "./loop.js";
export type { LoopOptions, LoopReport, VerifiedFinding } from "./loop.js";
export {
	runRollout,
	discoverRepos,
	loadManifest,
	parseRolloutArgs,
	teacherServingConfig,
	buildRepoAuditPrompt,
	ROLLOUT_SYSTEM_PROMPT,
	ROLLOUT_USAGE,
} from "./rollout.js";
export type {
	EnvMap,
	JournalFactory,
	ManifestRepo,
	RepoInventory,
	RepoStatus,
	RolloutAgentContext,
	RolloutAgentFactory,
	RolloutCliArgs,
	RolloutManifest,
	RolloutOptions,
	RolloutPocToolFactory,
	RolloutRepoResult,
	RolloutSummary,
	TeacherName,
} from "./rollout.js";
