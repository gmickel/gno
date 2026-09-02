/**
 * Agents command exports.
 *
 * @module src/cli/commands/agents
 */

export {
  BEGIN_MARKER,
  BLOCK_VERSION,
  END_MARKER,
  extractBlock,
  hashBlockBody,
  renderBlock,
  renderBlockBody,
} from "./block.js";
export {
  type AgentsOptions,
  installAgents,
  parseTargetOption,
  uninstallAgents,
  verifyAgents,
} from "./commands.js";
export {
  applyPlan,
  planTargets,
  type TargetPlan,
  unifiedDiff,
} from "./engine.js";
export {
  ENV_AGENTS_HOME_OVERRIDE,
  type HarnessId,
  HARNESS_IDS,
  type ResolvedTarget,
  resolveTargets,
} from "./harnesses.js";
