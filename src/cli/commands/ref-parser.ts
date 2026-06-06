/**
 * CLI compatibility re-export for document ref parsing.
 *
 * @module src/cli/commands/ref-parser
 */

export type { ParsedRef, ParseRefResult, RefType } from "../../core/ref-parser";
export {
  isGlobPattern,
  parseRef,
  resolveDocRef,
  splitRefs,
} from "../../core/ref-parser";
