/**
 * gno publish export command.
 *
 * @module src/cli/commands/publish
 */

// node:fs/promises — directory creation has no Bun-native equivalent.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";

import type {
  PublishArtifact,
  PublishVisibility,
} from "../../publish/artifact";
import type { PublishAssetEgressSummary } from "../../publish/attachment-resolver";
import type { SanitizeWarning } from "../../publish/obsidian-sanitize";

import { resolveDownloadsDir } from "../../core/user-dirs";
import {
  derivePublishArtifactFilename,
  serializePublishArtifact,
  slugify,
} from "../../publish/artifact";
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
        assetSummary: PublishAssetEgressSummary;
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

/** Write exactly the canonical byte sequence used by upload-size accounting. */
export async function writePublishArtifactFile(
  outPath: string,
  artifact: PublishArtifact
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, serializePublishArtifact(artifact));
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
    const { artifact, assetSummary, warnings } = await exportPublishArtifact({
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
          assetSummary,
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

    await writePublishArtifactFile(outPath, artifact);

    return {
      success: true,
      data: {
        artifact,
        assetSummary,
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

  const {
    artifact,
    assetSummary,
    outPath,
    preview,
    uploadUrl,
    warningsDisplay,
  } = result.data;
  const space = artifact.spaces[0];
  const warningsSection =
    warningsDisplay.length > 0
      ? ["", "Preprocessor notes:", ...warningsDisplay]
      : [];
  const assetSection = [
    "",
    "Asset summary:",
    `  assets=${assetSummary.assetCount} refs=${assetSummary.referenceCount} external=${assetSummary.externalCount}`,
    `  rawBytes=${assetSummary.rawBytes} encodedBytes=${assetSummary.encodedBytes} finalBytes=${assetSummary.finalUploadBytes}`,
    `  dedupSavedBytes=${assetSummary.dedupSavedBytes} unresolved=${assetSummary.diagnostics.length}`,
    ...assetSummary.diagnostics.map(
      (diagnostic) =>
        `  [${diagnostic.code}] ${diagnostic.noteSlug}: ${diagnostic.sourceRef} — ${diagnostic.message}`
    ),
  ];

  if (preview !== undefined) {
    return [
      `Preview (no file written) — ${space?.sourceType ?? "artifact"}`,
      `Route slug: ${space?.routeSlug ?? slugify(artifact.source)}`,
      `Visibility: ${space?.visibility ?? "public"}`,
      ...assetSection,
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
    ...assetSection,
    ...warningsSection,
  ].join("\n");
}
