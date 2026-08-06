/**
 * @attis/kernel — the audit kernel (spec §6, roadmap v2 item 2).
 *
 * A persistent Python sidecar ("persistent IPython" without Jupyter) per
 * audit session, booting with the audit helper library (repo.*, fork.*,
 * slither.*) over the fork substrate, behind an executor driver
 * interface, gated by a declarative execpolicy.
 */
export { createKernel } from "./kernel.js";
export type { Kernel, KernelOptions, ExecOptions, ExecResult, ExecErrorInfo } from "./kernel.js";
export {
	LocalDriver,
	DockerDriver,
	NotImplementedError,
	scrubEnv,
	ulimitPrefix,
} from "./driver.js";
export type { ExecutorDriver, ExecEnv, ExecSession, LocalDriverOptions } from "./driver.js";
export {
	loadPolicy,
	scanCode,
	PolicyError,
	DEFAULT_DECISION,
	FORBIDDEN_CODE_LITERALS,
} from "./policy.js";
export type { Policy, PolicyRule, PolicyDecision, CodeScan, ScanHit } from "./policy.js";
