/**
 * CLI command: gno context rm
 *
 * Remove a context.
 *
 * @module src/cli/commands/context/rm
 */

import { parseScope } from "../../../config";
import { applyConfigFileChange } from "../../../core/config-mutation";
import { normalizePersistedContextText } from "../../../core/context-identity";

/**
 * Exit codes
 */
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;

/**
 * Remove a context by scope.
 *
 * @param scope - Scope key to remove
 * @returns Exit code
 */
export async function contextRm(
  scope: string,
  text?: string,
  options: { configPath?: string } = {}
): Promise<number> {
  const parsed = parseScope(scope);
  if (!parsed) {
    console.error(`Error: Invalid scope format: ${scope}`);
    return EXIT_VALIDATION;
  }
  const normalizedText =
    text === undefined ? undefined : normalizePersistedContextText(text);
  if (normalizedText === "") {
    console.error("Error: Context text must not be empty");
    return EXIT_VALIDATION;
  }

  const mutation = await applyConfigFileChange(
    { configPath: options.configPath },
    (config) => {
      const matches = config.contexts
        .map((context, index) => ({ context, index }))
        .filter(
          ({ context }) =>
            context.scopeType === parsed.type &&
            context.scopeKey === parsed.key &&
            (normalizedText === undefined ||
              normalizePersistedContextText(context.text) === normalizedText)
        );
      if (matches.length === 0) {
        return {
          ok: false as const,
          error: `Context for scope "${scope}" not found`,
          code: "NOT_FOUND",
        };
      }
      if (normalizedText === undefined && matches.length > 1) {
        return {
          ok: false as const,
          error: `Multiple contexts exist for scope "${scope}"; pass the exact text to remove`,
          code: "AMBIGUOUS",
        };
      }
      config.contexts.splice(matches[0]!.index, 1);
      return { ok: true as const, config };
    }
  );
  if (!mutation.ok) {
    console.error(`Error: ${mutation.error}`);
    return EXIT_VALIDATION;
  }

  console.log(`Removed context for scope: ${scope}`);
  return EXIT_SUCCESS;
}
