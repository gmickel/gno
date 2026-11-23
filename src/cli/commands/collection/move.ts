/**
 * gno collection move - record an on-disk move of indexed documents to another
 * collection and/or path, keeping their identity and derived data.
 *
 * @module src/cli/commands/collection/move
 */

import type {
  RelocationRequest,
  RelocationResult,
} from "../../../ingestion/relocate";

import { defaultSyncService, withContentTypeRules } from "../../../ingestion";
import { CliError } from "../../errors";
import { initStore } from "../shared";

export interface CollectionMoveOptions {
  /** Tab-separated `source<TAB>destination` lines (`#` comments). */
  fromFile?: string;
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
  indexName?: string;
}

const DOCID_SOURCE = /^#[a-f0-9]{6,}$/;

/** Parse a mapping file: one `source<TAB>destination` per line. */
export function parseRelocationMap(text: string): RelocationRequest[] {
  const requests: RelocationRequest[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fields = raw.split("\t");
    // `#` starts a comment unless it starts a docid source (`#a1b2c3d4<TAB>...`).
    if (line.startsWith("#") && !DOCID_SOURCE.test(fields[0]?.trim() ?? "")) {
      continue;
    }
    if (fields.length !== 2 || !fields[0]?.trim() || !fields[1]?.trim()) {
      throw new CliError(
        "VALIDATION",
        `Mapping line ${index + 1}: expected "source<TAB>destination"`
      );
    }
    requests.push({ source: fields[0].trim(), destination: fields[1].trim() });
  }
  return requests;
}

export function formatRelocation(result: RelocationResult): string {
  const lines: string[] = [];
  for (const item of result.items) {
    if (item.status === "refused") {
      lines.push(
        `refused  ${item.source}${item.destination ? ` -> ${item.destination}` : ""}: ${item.code} ${item.message ?? ""}`.trimEnd()
      );
    } else {
      const verb = item.status === "relocated" ? "moved" : "would move";
      const note = item.titleChanged
        ? " (title changed; re-embed with gno embed)"
        : "";
      lines.push(`${verb}  ${item.source} -> ${item.destination}${note}`);
    }
  }
  for (const error of result.projectionErrors) {
    lines.push(`graph    ${error.relPath}: ${error.code} ${error.message}`);
  }
  const verb = result.dryRun ? "would be relocated" : "relocated";
  lines.push(
    `${result.relocated} document(s) ${verb}, ${result.refused} refused (${result.durationMs} ms)`
  );
  if (result.refused > 0) {
    lines.push(
      "Refused items are unchanged; gno update indexes them normally."
    );
  }
  return lines.join("\n");
}

/**
 * Relocate documents. Caller holds the write lease. Exits 1 (after printing
 * the receipt) when any item was refused; relocated items stay committed.
 */
export async function collectionMove(
  source: string | undefined,
  destination: string | undefined,
  options: CollectionMoveOptions = {}
): Promise<RelocationResult> {
  let requests: RelocationRequest[];
  if (options.fromFile) {
    if (source || destination) {
      throw new CliError(
        "VALIDATION",
        "Pass either <source> <destination> or --from-file, not both"
      );
    }
    const file = Bun.file(options.fromFile);
    if (!(await file.exists())) {
      throw new CliError(
        "VALIDATION",
        `Mapping file not found: ${options.fromFile}`
      );
    }
    requests = parseRelocationMap(await file.text());
  } else {
    if (!source || !destination) {
      throw new CliError(
        "VALIDATION",
        "Usage: gno collection move <source> <destination> (or --from-file <map>)"
      );
    }
    requests = [{ source, destination }];
  }
  if (requests.length === 0) {
    throw new CliError("VALIDATION", "Nothing to relocate");
  }

  // A dry run must not write, so it skips the config-to-index sync too.
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    ...(options.dryRun ? { syncConfig: false } : {}),
  });
  if (!initialized.ok) {
    throw new CliError("RUNTIME", initialized.error);
  }
  const { store, collections, config } = initialized;
  let result: RelocationResult;
  try {
    result = await defaultSyncService.relocateDocuments(
      collections,
      store,
      requests,
      { ...withContentTypeRules({}, config), dryRun: options.dryRun }
    );
  } finally {
    await store.close();
  }

  process.stdout.write(
    `${options.json ? JSON.stringify(result, null, 2) : formatRelocation(result)}\n`
  );
  if (result.refused > 0) {
    throw new CliError("VALIDATION", `${result.refused} item(s) refused`, {
      silent: true,
    });
  }
  return result;
}
