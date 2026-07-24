/**
 * CLI command: gno context add
 *
 * Add context metadata for a scope.
 *
 * @module src/cli/commands/context/add
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
 * Add context metadata for a scope.
 *
 * @param scope - Scope string (/, collection:, or gno://collection/path)
 * @param text - Context description text
 * @returns Exit code
 */
export async function contextAdd(
  scope: string,
  text: string,
  options: { configPath?: string } = {}
): Promise<number> {
  // Parse scope
  const parsed = parseScope(scope);
  if (!parsed) {
    console.error(`Error: Invalid scope format: ${scope}`);
    console.error(
      'Valid formats: "/" (global), "name:" (collection), or "gno://collection/path" (prefix)'
    );
    return EXIT_VALIDATION;
  }

  const normalizedText = normalizePersistedContextText(text);
  if (!normalizedText) {
    console.error("Error: Context text must not be empty");
    return EXIT_VALIDATION;
  }

  const mutation = await applyConfigFileChange(
    { configPath: options.configPath },
    (config) => {
      const duplicate = config.contexts.some(
        (context) =>
          context.scopeType === parsed.type &&
          context.scopeKey === parsed.key &&
          normalizePersistedContextText(context.text) === normalizedText
      );
      if (duplicate) {
        return {
          ok: false as const,
          error: `Context for scope "${scope}" with that text already exists`,
          code: "DUPLICATE",
        };
      }
      config.contexts.push({
        scopeType: parsed.type,
        scopeKey: parsed.key,
        text: normalizedText,
      });
      return { ok: true as const, config };
    }
  );
  if (!mutation.ok) {
    console.error(`Error: ${mutation.error}`);
    return EXIT_VALIDATION;
  }

  console.log(`Added context for scope: ${scope}`);
  return EXIT_SUCCESS;
}
