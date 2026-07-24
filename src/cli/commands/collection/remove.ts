/**
 * gno collection remove - Remove a collection
 */

import { removeCollection } from "../../../collection";
import { applyConfigFileChange } from "../../../core/config-mutation";
import { CliError } from "../../errors";

export async function collectionRemove(
  name: string,
  options: { configPath?: string } = {}
): Promise<void> {
  const mutation = await applyConfigFileChange(
    { configPath: options.configPath },
    (config) => {
      const result = removeCollection(config, { name });
      return result.ok
        ? {
            ok: true as const,
            config: result.config,
            value: result.collection,
          }
        : {
            ok: false as const,
            error: result.message,
            code: result.code,
          };
    }
  );

  if (!mutation.ok) {
    // Map collection error codes to CLI error codes
    const cliCode =
      mutation.code === "VALIDATION" ||
      mutation.code === "NOT_FOUND" ||
      mutation.code === "HAS_REFERENCES"
        ? "VALIDATION"
        : "RUNTIME";
    throw new CliError(cliCode, mutation.error);
  }

  process.stdout.write(
    `Collection "${mutation.value?.name}" removed successfully\n`
  );
}
