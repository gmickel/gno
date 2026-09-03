import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditFinding } from "../../src/core/audit-contract";

import { materializeAuditFinding } from "../../src/core/audit-report";
import { removePathRequired } from "../../src/core/file-ops";
import {
  applyFindingsRecords,
  findingsRecordFilename,
  listFindingsRecords,
  renderFindingsRecord,
} from "../../src/core/findings-records";
import { safeRm } from "../helpers/cleanup";

const RULE = "links.broken-target";
const NOW = new Date("2026-09-03T10:00:00.000Z");
const LATER = new Date("2026-09-03T16:00:00.000Z");

const brokenLink = (subject: string): AuditFinding =>
  materializeAuditFinding(RULE, "links", {
    severity: "error",
    subject,
    location: "line 3",
    message: "Link target does not resolve",
    evidence: [{ kind: "link", summary: "[[missing]]", uri: subject }],
    guidance: ["Fix or remove the link"],
  });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-findings-records-"));
});

afterEach(async () => {
  await safeRm(root);
});

const apply = (
  findings: AuditFinding[],
  now: Date = NOW,
  overrides: Partial<Parameters<typeof applyFindingsRecords>[0]> = {}
) =>
  applyFindingsRecords({
    root,
    findings,
    settledRuleIds: new Set([RULE]),
    allowResolve: true,
    now,
    ...overrides,
  });

describe("findings records", () => {
  test("writes one record per finding inside the root, named from the finding id", async () => {
    const finding = brokenLink("gno://notes/a.md");
    const result = await apply([finding]);
    expect(result).toMatchObject({ written: 1, open: 1, unchanged: 0 });
    const filename = findingsRecordFilename(finding.id);
    expect(filename).toMatch(/^finding-[a-f0-9]{24}\.md$/);
    const content = await Bun.file(join(root, filename)).text();
    expect(content).toContain(`findingId: "${finding.id}"`);
    expect(content).toContain("status: open");
    expect(content).toContain("gno://notes/a.md");
    expect(await readdir(root)).toEqual([filename]);
  });

  test("second run with the same finding is a byte-identical no-op (identity upsert)", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    const path = join(root, findingsRecordFilename(finding.id));
    const before = await stat(path);
    const beforeContent = await Bun.file(path).text();
    const result = await apply([finding], LATER);
    expect(result).toMatchObject({ written: 0, unchanged: 1, open: 1 });
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await Bun.file(path).text()).toBe(beforeContent);
    expect(await readdir(root)).toHaveLength(1);
  });

  test("a finding that disappears is marked resolved, then reopened if it returns", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    const resolved = await apply([], LATER);
    expect(resolved).toMatchObject({ resolved: 1, open: 0 });
    const path = join(root, findingsRecordFilename(finding.id));
    const content = await Bun.file(path).text();
    expect(content).toContain("status: resolved");
    expect(content).toContain(`resolvedAt: "${LATER.toISOString()}"`);
    const [header] = await listFindingsRecords(root);
    expect(header?.status).toBe("resolved");

    const reopened = await apply([finding], LATER);
    expect(reopened).toMatchObject({ reopened: 1, written: 0, open: 1 });
    expect(await Bun.file(path).text()).toContain("status: open");
    expect(await Bun.file(path).text()).toContain(
      `firstSeenAt: "${NOW.toISOString()}"`
    );
  });

  test("does not resolve when the report is truncated or the rule did not settle", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    const truncated = await apply([], LATER, { allowResolve: false });
    expect(truncated).toMatchObject({ resolved: 0, open: 1 });
    const unsettled = await apply([], LATER, { settledRuleIds: new Set() });
    expect(unsettled).toMatchObject({ resolved: 0, open: 1 });
  });

  test("retention deletes resolved records older than the window and leaves foreign files alone", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    await apply([], LATER);
    await writeFile(join(root, "finding-notmine.md"), "# hand-written\n");
    await writeFile(join(root, "README.md"), "# keep me\n");
    await mkdir(join(root, "sub"));
    await writeFile(
      join(root, "sub", findingsRecordFilename(finding.id)),
      renderFindingsRecord({
        finding,
        status: "open",
        firstSeenAt: NOW.toISOString(),
        resolvedAt: null,
      })
    );
    const muchLater = new Date(LATER.getTime() + 31 * 86_400_000);
    const result = await apply([], muchLater);
    expect(result).toMatchObject({ deleted: 1, open: 0 });
    const names = (await readdir(root)).sort();
    expect(names).toEqual(["README.md", "finding-notmine.md", "sub"]);
    expect(await readdir(join(root, "sub"))).toHaveLength(1);
  });

  test("retention treats a record removed by hand between listing and deletion as already deleted", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    await apply([], LATER);
    // Records resolve through realpath (macOS tmpdir is a /private symlink).
    const path = await realpath(join(root, findingsRecordFilename(finding.id)));
    const removed: string[] = [];
    // Simulate the race: the record vanishes after listing, right before the
    // retention pass removes it (the default remover must tolerate ENOENT).
    const removePath = async (target: string): Promise<void> => {
      removed.push(target);
      if (target === path) await unlink(path);
      await removePathRequired(target);
    };
    const muchLater = new Date(LATER.getTime() + 31 * 86_400_000);
    const result = await apply([], muchLater, { removePath });
    expect(removed).toEqual([path]);
    expect(result).toMatchObject({ deleted: 1, open: 0 });
    expect(await readdir(root)).toEqual([]);
  });

  test("a resolved record with an unparsable resolvedAt ages from now, not into immediate deletion", async () => {
    const finding = brokenLink("gno://notes/a.md");
    await apply([finding]);
    await apply([], LATER);
    const path = join(root, findingsRecordFilename(finding.id));
    const content = await Bun.file(path).text();
    await writeFile(
      path,
      content.replace(
        `resolvedAt: "${LATER.toISOString()}"`,
        'resolvedAt: "not-a-date"'
      )
    );
    expect(await Bun.file(path).text()).toContain('resolvedAt: "not-a-date"');

    // Next pass keeps it: an unparsable timestamp counts as "just now".
    const kept = await apply([], new Date(LATER.getTime() + 86_400_000));
    expect(kept.deleted).toBe(0);
    expect(await readdir(root)).toEqual([findingsRecordFilename(finding.id)]);
  });

  test("rejects a root that is not a directory", async () => {
    let threw = false;
    try {
      await applyFindingsRecords({
        root: join(root, "missing"),
        findings: [],
        settledRuleIds: new Set(),
        allowResolve: true,
        now: NOW,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
