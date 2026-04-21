/**
 * gno publish export command.
 *
 * @module src/cli/commands/publish
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

import type {
  PublishArtifact,
  PublishVisibility,
} from "../../publish/artifact";
import type { SanitizeWarning } from "../../publish/obsidian-sanitize";

import { resolveDownloadsDir } from "../../core/user-dirs";
import { derivePublishArtifactFilename, slugify } from "../../publish/artifact";
import { exportPublishArtifact } from "../../publish/export-service";
import { formatSanitizeWarnings } from "../../publish/obsidian-sanitize";
import { initStore } from "./shared";

export interface PublishExportOptions {
  configPath?: string;
  encryptionPassphrase?: string;
  json?: boolean;
  out?: string;
  preview?: boolean;
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
        preview?: string;
        uploadUrl: string;
        warnings: SanitizeWarning[];
        warningsDisplay: string[];
      };
    }
  | { success: false; error: string; isValidation?: boolean };

function formatExportDateStamp(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10).replaceAll("-", "");
}

export async function buildDefaultPublishExportPath(
  artifact: PublishArtifact
): Promise<string> {
  const fileName = derivePublishArtifactFilename(artifact).replace(
    /\.json$/u,
    ""
  );
  const downloadsDir = await resolveDownloadsDir();
  return join(
    downloadsDir,
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
    const { artifact, warnings } = await exportPublishArtifact({
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
    const warningsDisplay = formatSanitizeWarnings(warnings);

    if (options.preview) {
      const preview =
        artifact.version === 1
          ? (artifact.spaces[0]?.notes
              .map((note) => `\n# ${note.title}\n\n${note.markdown.trim()}`)
              .join("\n\n---\n") ?? "")
          : "(Encrypted artifact — preview unavailable)";
      return {
        success: true,
        data: {
          artifact,
          outPath: "",
          preview,
          uploadUrl: "https://gno.sh/studio",
          warnings,
          warningsDisplay,
        },
      };
    }

    const outPath =
      options.out?.trim() || (await buildDefaultPublishExportPath(artifact));

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(artifact, null, 2));

    return {
      success: true,
      data: {
        artifact,
        outPath,
        uploadUrl: "https://gno.sh/studio",
        warnings,
        warningsDisplay,
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

  const { artifact, outPath, preview, uploadUrl, warningsDisplay } =
    result.data;
  const space = artifact.spaces[0];
  const warningsSection =
    warningsDisplay.length > 0
      ? ["", "Preprocessor notes:", ...warningsDisplay]
      : [];

  if (preview !== undefined) {
    return [
      `Preview (no file written) — ${space?.sourceType ?? "artifact"}`,
      `Route slug: ${space?.routeSlug ?? slugify(artifact.source)}`,
      `Visibility: ${space?.visibility ?? "public"}`,
      ...warningsSection,
      "",
      "─── sanitized markdown ───",
      preview.trim(),
    ].join("\n");
  }

  return [
    `Exported ${space?.sourceType ?? "artifact"} to ${outPath}`,
    `Route slug: ${space?.routeSlug ?? slugify(artifact.source)}`,
    `Visibility: ${space?.visibility ?? "public"}`,
    `Filename: ${derivePublishArtifactFilename(artifact)}`,
    `Next: open ${uploadUrl} and drop ${outPath} into the upload zone.`,
    ...warningsSection,
  ].join("\n");
}
