/**
 * Findings records: deterministic Markdown records for audit findings.
 *
 * One file per finding identity under the configured findings collection
 * root. Identity is the audit finding id (hash of rule + subject/location +
 * evidence fingerprint), so repeated passes upsert instead of duplicating.
 * Records are ordinary Markdown sources: retrieval, egress, and deletion
 * follow the normal collection rules. Nothing here touches other paths.
 *
 * @module src/core/findings-records
 */

// node:fs/promises: realpath/stat/rename/unlink are structure ops without Bun equivalents.
import { realpath, rename, stat, unlink } from "node:fs/promises";
// node:path: join/basename have no Bun path utilities.
import { basename, join } from "node:path";

import type { AuditFinding } from "./audit-contract";

import { parseFrontmatter } from "../ingestion/frontmatter";
import { removePathRequired } from "./file-ops";

/** Resolved records older than this are deleted on the next pass. */
export const FINDINGS_RESOLVED_RETENTION_DAYS = 30;
/** Hard ceiling on records per collection; oldest resolved go first. */
export const FINDINGS_MAX_RECORDS = 2000;

const RECORD_PREFIX = "finding-";
const RECORD_ID_CHARS = 24;
const FINDING_ID_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_GLOB = new Bun.Glob(`${RECORD_PREFIX}*.md`);
const RETENTION_MS = FINDINGS_RESOLVED_RETENTION_DAYS * 86_400_000;

export type FindingsRecordStatus = "open" | "resolved";

export interface FindingsRecordHeader {
  path: string;
  findingId: string;
  ruleId: string;
  status: FindingsRecordStatus;
  firstSeenAt: string;
  resolvedAt: string | null;
}

export interface ApplyFindingsRecordsInput {
  /** Absolute findings collection root. Records are written directly beneath it. */
  root: string;
  findings: readonly AuditFinding[];
  /** Rules that completed (pass or fail) this pass; only their records may resolve. */
  settledRuleIds: ReadonlySet<string>;
  /** False when the report is truncated or partial: absence proves nothing. */
  allowResolve: boolean;
  now: Date;
  /**
   * Removes one record file; must treat ENOENT as already deleted. Defaults to
   * `removePathRequired`. Injectable so the listing-to-deletion race is testable
   * without patching module bindings.
   */
  removePath?: (path: string) => Promise<void>;
}

export interface ApplyFindingsRecordsResult {
  written: number;
  reopened: number;
  resolved: number;
  deleted: number;
  unchanged: number;
  open: number;
}

export function findingsRecordFilename(findingId: string): string {
  return `${RECORD_PREFIX}${findingId.slice(0, RECORD_ID_CHARS)}.md`;
}

const yamlScalar = (value: string | null): string =>
  value === null ? "null" : JSON.stringify(value);

const yamlList = (values: readonly string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

export interface RenderFindingsRecordInput {
  finding: AuditFinding;
  status: FindingsRecordStatus;
  firstSeenAt: string;
  resolvedAt: string | null;
}

/** Deterministic record body: same inputs, same bytes. */
export function renderFindingsRecord(input: RenderFindingsRecordInput): string {
  const { finding } = input;
  const lines: string[] = [
    "---",
    `type: finding`,
    `gnoFinding: true`,
    `findingId: ${yamlScalar(finding.id)}`,
    `rule: ${yamlScalar(finding.ruleId)}`,
    `category: ${yamlScalar(finding.category)}`,
    `severity: ${yamlScalar(finding.severity)}`,
    `status: ${input.status}`,
    `subject: ${yamlScalar(finding.subject)}`,
    `location: ${yamlScalar(finding.location)}`,
    `firstSeenAt: ${yamlScalar(input.firstSeenAt)}`,
    `resolvedAt: ${yamlScalar(input.resolvedAt)}`,
    `evidenceFingerprint: ${yamlScalar(finding.evidenceFingerprint)}`,
    `source: gno-audit`,
    `tags: ${yamlList(["finding", "audit", finding.category, finding.severity])}`,
    "---",
    "",
    `# ${finding.ruleId}: ${finding.subject}`,
    "",
    finding.message,
    "",
    `- Check: ${finding.ruleId} (${finding.category}, ${finding.severity})`,
    `- Subject: ${finding.subject}`,
    `- Location: ${finding.location ?? "(none)"}`,
    `- Status: ${input.status}`,
    `- First seen: ${input.firstSeenAt}`,
    `- Resolved: ${input.resolvedAt ?? "(open)"}`,
  ];
  if (finding.evidence.length > 0) {
    lines.push("", "## Evidence", "");
    for (const evidence of finding.evidence) {
      const pointer = evidence.uri ?? evidence.path;
      const detail = evidence.detail ? ` — ${evidence.detail}` : "";
      lines.push(
        `- ${evidence.kind}: ${evidence.summary}${pointer ? ` (${pointer})` : ""}${detail}`
      );
    }
  }
  if (finding.guidance.length > 0) {
    lines.push("", "## Guidance", "");
    for (const guidance of finding.guidance) lines.push(`- ${guidance}`);
  }
  lines.push(
    "",
    "Written by the GNO daemon findings pass. Report-only: fix the subject source; this record resolves on the next pass.",
    ""
  );
  return lines.join("\n");
}

const metadataString = (
  metadata: Record<string, unknown>,
  key: string
): string | null => {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Parse one candidate file; null unless it is a record this writer owns. */
export function parseFindingsRecordHeader(
  path: string,
  content: string
): FindingsRecordHeader | null {
  const { metadata } = parseFrontmatter(content);
  const marker = metadata.gnoFinding;
  if (marker !== true && marker !== "true") return null;
  const findingId = metadataString(metadata, "findingId");
  if (!findingId || !FINDING_ID_PATTERN.test(findingId)) return null;
  if (basename(path) !== findingsRecordFilename(findingId)) return null;
  const status = metadataString(metadata, "status");
  if (status !== "open" && status !== "resolved") return null;
  const ruleId = metadataString(metadata, "rule");
  const firstSeenAt = metadataString(metadata, "firstSeenAt");
  if (!ruleId || !firstSeenAt) return null;
  const resolvedAt = metadataString(metadata, "resolvedAt");
  return {
    path,
    findingId,
    ruleId,
    status,
    firstSeenAt,
    resolvedAt: resolvedAt === "null" ? null : resolvedAt,
  };
}

export async function listFindingsRecords(
  root: string
): Promise<FindingsRecordHeader[]> {
  const headers: FindingsRecordHeader[] = [];
  for await (const name of RECORD_GLOB.scan({
    cwd: root,
    onlyFiles: true,
    dot: false,
  })) {
    if (name.includes("/") || name.includes("\\")) continue;
    const path = join(root, name);
    try {
      const header = parseFindingsRecordHeader(
        path,
        await Bun.file(path).text()
      );
      if (header) headers.push(header);
    } catch {
      // Unreadable candidate: not ours to touch.
    }
  }
  return headers.sort((left, right) =>
    left.findingId < right.findingId ? -1 : 1
  );
}

async function writeRecordAtomically(
  path: string,
  content: string
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await Bun.write(temporaryPath, content, { createPath: false, mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveRecordRoot(root: string): Promise<string> {
  const resolved = await realpath(root);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`findings collection root is not a directory: ${root}`);
  }
  return resolved;
}

/**
 * Age of a resolved record. A missing or unparsable `resolvedAt` reads as
 * "just now" (age 0): the record then ages out through the normal retention
 * window instead of being deleted on the very next pass, and the retention
 * comparator never sees NaN.
 */
const resolvedAge = (header: FindingsRecordHeader, now: Date): number => {
  const resolvedAt = header.resolvedAt ? Date.parse(header.resolvedAt) : NaN;
  return Number.isFinite(resolvedAt)
    ? Math.max(0, now.getTime() - resolvedAt)
    : 0;
};

/**
 * Upsert current findings, resolve vanished ones, apply bounded retention.
 * Only files that parse as records this writer produced are ever rewritten
 * or deleted; everything else in the root is left alone.
 */
export async function applyFindingsRecords(
  input: ApplyFindingsRecordsInput
): Promise<ApplyFindingsRecordsResult> {
  const root = await resolveRecordRoot(input.root);
  const nowIso = input.now.toISOString();
  const removePath = input.removePath ?? removePathRequired;
  const existing = new Map(
    (await listFindingsRecords(root)).map((header) => [
      header.findingId,
      header,
    ])
  );
  const result: ApplyFindingsRecordsResult = {
    written: 0,
    reopened: 0,
    resolved: 0,
    deleted: 0,
    unchanged: 0,
    open: 0,
  };
  const currentIds = new Set<string>();

  for (const finding of input.findings) {
    if (!FINDING_ID_PATTERN.test(finding.id) || currentIds.has(finding.id)) {
      continue;
    }
    currentIds.add(finding.id);
    const header = existing.get(finding.id);
    if (header?.status === "open") {
      result.unchanged += 1;
      continue;
    }
    const path = join(root, findingsRecordFilename(finding.id));
    await writeRecordAtomically(
      path,
      renderFindingsRecord({
        finding,
        status: "open",
        firstSeenAt: header?.firstSeenAt ?? nowIso,
        resolvedAt: null,
      })
    );
    if (header) result.reopened += 1;
    else result.written += 1;
    existing.set(finding.id, {
      path,
      findingId: finding.id,
      ruleId: finding.ruleId,
      status: "open",
      firstSeenAt: header?.firstSeenAt ?? nowIso,
      resolvedAt: null,
    });
  }

  for (const header of existing.values()) {
    if (header.status !== "open" || currentIds.has(header.findingId)) continue;
    if (!input.allowResolve || !input.settledRuleIds.has(header.ruleId)) {
      continue;
    }
    const content = await Bun.file(header.path).text();
    const resolvedContent = rewriteRecordStatus(content, "resolved", nowIso);
    if (resolvedContent === null) continue;
    await writeRecordAtomically(header.path, resolvedContent);
    header.status = "resolved";
    header.resolvedAt = nowIso;
    result.resolved += 1;
  }

  const expired = [...existing.values()].filter(
    (header) =>
      header.status === "resolved" &&
      !currentIds.has(header.findingId) &&
      resolvedAge(header, input.now) > RETENTION_MS
  );
  // A record removed by hand between listing and retention is already gone:
  // ENOENT counts as deleted instead of failing the whole pass.
  for (const header of expired) {
    await removePath(header.path);
    existing.delete(header.findingId);
    result.deleted += 1;
  }
  if (existing.size > FINDINGS_MAX_RECORDS) {
    const surplus = [...existing.values()]
      .filter((header) => header.status === "resolved")
      .sort(
        (left, right) =>
          resolvedAge(right, input.now) - resolvedAge(left, input.now)
      )
      .slice(0, existing.size - FINDINGS_MAX_RECORDS);
    for (const header of surplus) {
      await removePath(header.path);
      existing.delete(header.findingId);
      result.deleted += 1;
    }
  }

  for (const header of existing.values()) {
    if (header.status === "open") result.open += 1;
  }
  return result;
}

/**
 * Flip the status/resolvedAt frontmatter lines and the matching body lines
 * without re-rendering (the original finding payload is not re-read).
 */
export function rewriteRecordStatus(
  content: string,
  status: FindingsRecordStatus,
  resolvedAt: string | null
): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const frontmatter = content
    .slice(4, end)
    .split("\n")
    .map((line) => {
      if (line.startsWith("status: ")) return `status: ${status}`;
      if (line.startsWith("resolvedAt: ")) {
        return `resolvedAt: ${yamlScalar(resolvedAt)}`;
      }
      return line;
    })
    .join("\n");
  const body = content
    .slice(end + 5)
    .split("\n")
    .map((line) => {
      if (line.startsWith("- Status: ")) return `- Status: ${status}`;
      if (line.startsWith("- Resolved: ")) {
        return `- Resolved: ${resolvedAt ?? "(open)"}`;
      }
      return line;
    })
    .join("\n");
  return `---\n${frontmatter}\n---\n${body}`;
}
