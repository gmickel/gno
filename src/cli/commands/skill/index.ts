/**
 * Skill command exports.
 *
 * @module src/cli/commands/skill
 */

export { type InstallOptions, installSkill } from './install.js';
export {
  resolveAllPaths,
  resolveSkillPaths,
  type SkillPathOptions,
  type SkillPaths,
  type SkillScope,
  type SkillTarget,
  validatePathForDeletion,
} from './paths.js';
export { type PathsOptions, showPaths } from './paths-cmd.js';
export { type ShowOptions, showSkill } from './show.js';
export { type UninstallOptions, uninstallSkill } from './uninstall.js';
