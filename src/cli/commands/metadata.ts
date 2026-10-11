/**
 * gno metadata - list the typed metadata keys indexed documents carry.
 *
 * @module src/cli/commands/metadata
 */

import {
  formatMetadataSummary,
  type MetadataSummary,
  readMetadataSummary,
} from "../../core/metadata-discovery";
import { initStore } from "./shared";

export interface MetadataListOptions {
  configPath?: string;
  indexName?: string;
  collection?: string;
  values?: number;
}

export type MetadataListResult =
  | { success: true; data: MetadataSummary }
  | { success: false; error: string; isValidation?: boolean };

export async function metadataList(
  options: MetadataListOptions = {}
): Promise<MetadataListResult> {
  const initResult = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
  });
  if (!initResult.ok) return { success: false, error: initResult.error };
  const { store } = initResult;
  try {
    return {
      success: true,
      data: await readMetadataSummary(store, {
        collection: options.collection,
        values: options.values,
      }),
    };
  } catch (cause) {
    return {
      success: false,
      error: cause instanceof Error ? cause.message : String(cause),
      isValidation: cause instanceof RangeError,
    };
  } finally {
    await store.close();
  }
}

export function formatMetadataList(
  data: MetadataSummary,
  options: { json?: boolean; md?: boolean }
): string {
  if (options.json) return JSON.stringify(data, null, 2);
  if (!options.md) return formatMetadataSummary(data);
  const lines = [
    "# Typed metadata",
    "",
    `*${data.documentsWithMetadata} of ${data.documents} documents${data.collection ? ` in \`${data.collection}\`` : ""}*`,
  ];
  if (data.keys.length === 0) return lines.join("\n");
  lines.push(
    "",
    "| Key | Types | Documents | Common values |",
    "|---|---|---|---|"
  );
  for (const key of data.keys) {
    const values = key.values
      .map((item) => `\`${JSON.stringify(item.value)}\` (${item.documents})`)
      .join(", ");
    lines.push(
      `| \`${key.key}\` | ${key.types.join(", ")} | ${key.documents} | ${values}${key.valuesTruncated ? ", ..." : ""} |`
    );
  }
  return lines.join("\n");
}
