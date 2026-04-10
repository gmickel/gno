/**
 * gno publish export command.
 *
 * @module src/cli/commands/publish
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  PublishArtifact,
  PublishVisibility,
} from "../../publish/artifact";

import { derivePublishArtifactFilename, slugify } from "../../publish/artifact";
import { exportPublishArtifact } from "../../publish/export-service";
import { initStore } from "./shared";

export interface PublishExportOptions {
  configPath?: string;
  json?: boolean;
  out: string;
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

export async function publishExport(
  target: string,
  options: PublishExportOptions
): Promise<PublishExportResult> {
  if (!options.out.trim()) {
    return {
      success: false,
      error: "--out is required",
      isValidation: true,
    };
  }

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
        summary: options.summary,
        title: options.title,
        visibility: options.visibility,
      },
      store,
      target,
    });

    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, JSON.stringify(artifact, null, 2));

    return {
      success: true,
      data: {
        artifact,
        outPath: options.out,
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
