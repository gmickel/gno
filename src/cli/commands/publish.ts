/**
 * gno publish export command.
 *
 * @module src/cli/commands/publish
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";

import type {
  PublishArtifact,
  PublishVisibility,
} from "../../publish/artifact";

import { derivePublishArtifactFilename, slugify } from "../../publish/artifact";
import { exportPublishArtifact } from "../../publish/export-service";
import { initStore } from "./shared";

export interface PublishExportOptions {
  configPath?: string;
  encryptionPassphrase?: string;
  json?: boolean;
  out?: string;
  slug?: string;
  summary?: string;
  title?: string;
  visibility?: PublishVisibility;
}

export type PublishExportResult =
  | {
      success: true;
      data: {
        artifact: PublishArtifact;
        outPath: string;
        uploadUrl: string;
      };
    }
  | { success: false; error: string; isValidation?: boolean };

function formatExportDateStamp(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10).replaceAll("-", "");
}

export function buildDefaultPublishExportPath(
  artifact: PublishArtifact
): string {
  const fileName = derivePublishArtifactFilename(artifact).replace(
    /\.json$/u,
    ""
  );
  return join(
    homedir(),
    "Downloads",
    `${fileName}-${formatExportDateStamp(artifact.exportedAt)}.json`
  );
}

export async function publishExport(
  target: string,
  options: PublishExportOptions
): Promise<PublishExportResult> {
  const initResult = await initStore({
    configPath: options.configPath,
    syncConfig: false,
  });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { collections, store } = initResult;

  try {
    const artifact = await exportPublishArtifact({
      collections,
      options: {
        routeSlug: options.slug,
        encryptionPassphrase: options.encryptionPassphrase,
        summary: options.summary,
        title: options.title,
        visibility: options.visibility,
      },
      store,
      target,
    });
    const outPath =
      options.out?.trim() || buildDefaultPublishExportPath(artifact);

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(artifact, null, 2));

    return {
      success: true,
      data: {
        artifact,
        outPath,
        uploadUrl: "https://gno.sh/studio",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await store.close();
  }
}

export function formatPublishExport(
  result: PublishExportResult,
  options: Pick<PublishExportOptions, "json">
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: {
          code: result.isValidation ? "VALIDATION" : "RUNTIME",
          message: result.error,
        },
      });
    }
    return `Error: ${result.error}`;
  }

  if (options.json) {
    return JSON.stringify(result.data, null, 2);
  }

  const { artifact, outPath, uploadUrl } = result.data;
  const space = artifact.spaces[0];

  return [
    `Exported ${space?.sourceType ?? "artifact"} to ${outPath}`,
    `Route slug: ${space?.routeSlug ?? slugify(artifact.source)}`,
    `Visibility: ${space?.visibility ?? "public"}`,
    `Filename: ${derivePublishArtifactFilename(artifact)}`,
    `Next: open ${uploadUrl} and drop ${outPath} into the upload zone.`,
  ].join("\n");
}
