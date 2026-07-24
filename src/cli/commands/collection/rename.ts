/**
 * gno collection rename - Rename a collection
 */

import { CollectionSchema, getCollectionFromScope } from "../../../config";
import { applyConfigFileChange } from "../../../core/config-mutation";
import { CliError } from "../../errors";

export async function collectionRename(
  oldName: string,
  newName: string,
  options: { configPath?: string } = {}
): Promise<void> {
  const oldCollectionName = oldName.toLowerCase();
  const newCollectionName = newName.toLowerCase();

  const mutation = await applyConfigFileChange(
    { configPath: options.configPath },
    (config) => {
      const collection = config.collections.find(
        (item) => item.name === oldCollectionName
      );
      if (!collection) {
        return {
          ok: false as const,
          error: `Collection "${oldCollectionName}" not found`,
          code: "NOT_FOUND",
        };
      }
      if (config.collections.some((item) => item.name === newCollectionName)) {
        return {
          ok: false as const,
          error: `Collection "${newCollectionName}" already exists`,
          code: "DUPLICATE",
        };
      }
      const validation = CollectionSchema.safeParse({
        ...collection,
        name: newCollectionName,
      });
      if (!validation.success) {
        return {
          ok: false as const,
          error: `Invalid collection name: ${validation.error.issues[0]?.message ?? "unknown error"}`,
          code: "VALIDATION",
        };
      }
      collection.name = newCollectionName;
      for (const context of config.contexts) {
        if (getCollectionFromScope(context.scopeKey) !== oldCollectionName) {
          continue;
        }
        if (context.scopeType === "collection") {
          context.scopeKey = `${newCollectionName}:`;
        } else if (context.scopeType === "prefix") {
          context.scopeKey = context.scopeKey.replace(
            `gno://${oldCollectionName}/`,
            `gno://${newCollectionName}/`
          );
        }
      }
      return { ok: true as const, config };
    }
  );
  if (!mutation.ok) {
    throw new CliError(
      ["NOT_FOUND", "DUPLICATE", "VALIDATION"].includes(mutation.code)
        ? "VALIDATION"
        : "RUNTIME",
      mutation.error
    );
  }

  process.stdout.write(
    `Collection "${oldCollectionName}" renamed to "${newCollectionName}"\n`
  );
}
