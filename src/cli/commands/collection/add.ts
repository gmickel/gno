/**
 * gno collection add - Add a new collection
 */

import { addCollection } from "../../../collection";
import { pathExists, toAbsolutePath } from "../../../config";
import { applyConfigFileChange } from "../../../core/config-mutation";
import { CliError } from "../../errors";

interface AddOptions {
  embedModel?: string;
  name?: string;
  pattern?: string;
  include?: string;
  exclude?: string;
  update?: string;
  configPath?: string;
}

export async function collectionAdd(
  path: string,
  options: AddOptions
): Promise<void> {
  // Validate required name
  if (!options.name) {
    throw new CliError("VALIDATION", "--name is required");
  }

  // Validate path exists BEFORE loading config (user-friendly error ordering)
  const absolutePath = toAbsolutePath(path);
  const exists = await pathExists(absolutePath);
  if (!exists) {
    throw new CliError("VALIDATION", `Path does not exist: ${absolutePath}`);
  }

  const mutation = await applyConfigFileChange(
    { configPath: options.configPath },
    async (config) => {
      const result = await addCollection(config, {
        path,
        name: options.name!,
        pattern: options.pattern,
        include: options.include,
        exclude: options.exclude,
        models: options.embedModel
          ? {
              embed: options.embedModel,
            }
          : undefined,
        updateCmd: options.update,
      });
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
      mutation.code === "PATH_NOT_FOUND" ||
      mutation.code === "DUPLICATE"
        ? "VALIDATION"
        : "RUNTIME";
    throw new CliError(cliCode, mutation.error);
  }

  process.stdout.write(
    `Collection "${mutation.value?.name}" added successfully\n`
  );
  process.stdout.write(`Path: ${mutation.value?.path}\n`);
}
