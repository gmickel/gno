/**
 * Link audit over a link workspace (R7, A12, A13).
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises chmod/mkdir: filesystem structure ops, no Bun equivalent.
import { chmod, mkdir } from "node:fs/promises";
// node:path join: path algebra, no Bun equivalent.
import { join } from "node:path";

import type { AuditReport } from "../../src/core/audit";

import { ConfigSchema } from "../../src/config/types";
import { evaluateLinkAudit } from "../../src/core/audit-links";
import {
  listWorkspaceFiles,
  markOutsideIndexLinks,
} from "../../src/core/audit-outside-index";
import { runWorkspaceAudit } from "../../src/core/audit-workspace";
import { captureAuditLinkSnapshot } from "../../src/store/sqlite/graph-link-resolver";
import {
  openLinkWorkspaceFixture,
  type LinkWorkspaceFixture,
} from "../fixtures/link-workspace/fixture";

let fixture: LinkWorkspaceFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const audit = async (
  f: LinkWorkspaceFixture,
  collectionFilters: string[] = []
): Promise<AuditReport> => {
  const result = await runWorkspaceAudit({
    store: f.store,
    config: ConfigSchema.parse({ version: "1.0", collections: f.collections }),
    collections: f.collections,
    indexName: "default",
    categories: ["links"],
    collectionFilters,
    maxFindings: "all",
  });
  if (!result.ok) throw new Error(result.error);
  return result.report;
};

const findings = (report: AuditReport, ruleId: string) =>
  report.findings
    .filter((finding) => finding.ruleId === ruleId)
    .map((finding) => ({
      subject: finding.subject,
      detail: JSON.parse(finding.evidence[0]?.detail ?? "{}") as Record<
        string,
        unknown
      >,
    }));

describe("workspace link audit (R7)", () => {
  test("cross-collection links are resolved, ties list candidates, fields are separate", async () => {
    fixture = await openLinkWorkspaceFixture();
    const report = await audit(fixture);
    const unresolved = findings(report, "links.local-targets").map(
      ({ detail }) => detail.normalizedTarget
    );
    // Only genuinely missing targets remain unresolved.
    expect(unresolved.sort()).toEqual(
      ["../../../../escape", "missing note", "roadmap"].sort()
    );
    const unknownPrefix = findings(report, "links.local-targets").find(
      ({ detail }) => detail.referenceKind === "explicit-collection"
    );
    expect(unknownPrefix?.detail).toMatchObject({
      resolutionStatus: "unresolved",
      resolvedScope: null,
    });
    const [tie] = findings(report, "links.ambiguous-targets");
    expect(tie?.detail).toMatchObject({
      referenceKind: "wiki-name",
      resolutionStatus: "ambiguous",
      resolvedScope: "cross-collection",
      candidateCount: 2,
      candidates: ["gno://work/A/Shared.md", "gno://work/B/Shared.md"],
    });
    // Vault-root path links never show up as ambiguous.
    expect(findings(report, "links.ambiguous-targets")).toHaveLength(1);
  });

  test("a scoped audit counts inbound links from other collections and withholds their identities", async () => {
    fixture = await openLinkWorkspaceFixture();
    const workOnly = await audit(fixture, ["work"]);
    const orphans = findings(workOnly, "links.orphans").map(
      ({ subject }) => subject
    );
    // Lonely.md is linked only from ai: connected, not an orphan. Shared A/B
    // are targets of a tied (non-traversable) link only: orphans.
    expect(orphans).not.toContain("gno://work/Lonely.md");
    expect(orphans).toContain("gno://work/A/Shared.md");

    const aiOnly = await audit(fixture, ["ai"]);
    const [tie] = findings(aiOnly, "links.ambiguous-targets");
    expect(tie?.detail).toMatchObject({
      resolvedScope: "cross-collection",
      candidateCount: 2,
      candidates: [],
      candidatesWithheld: 2,
    });
    expect(JSON.stringify(aiOnly.findings)).not.toContain("gno://work/");
  });
});

/** Files in the vault that are not indexed documents. */
const writeVaultFile = async (
  f: LinkWorkspaceFixture,
  relPath: string,
  body = "x"
): Promise<void> => {
  const path = join(f.vault, relPath);
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, body);
};

const PARITY_NOTE = [
  "# Parity",
  "",
  "| Link | Kind |",
  "| --- | --- |",
  "| [[Roadmap\\|Plan]] | escaped table alias |",
  "",
  "![[diagram.png]] ![[Attachments/report.pdf|200]]",
  "[[Secret]] [[Old Plan]]",
  "[Title [draft] (v2](Agents/_index.md)",
  "[[Nowhere]] [[diagram]]",
  "",
].join("\n");

const openParityFixture = async (): Promise<LinkWorkspaceFixture> => {
  const f = await openLinkWorkspaceFixture();
  await writeVaultFile(f, "Attachments/diagram.png");
  await writeVaultFile(f, "Attachments/report.pdf");
  await writeVaultFile(f, "Archive/Old Plan.md", "# Old plan\n");
  await writeVaultFile(f, ".trash/Nowhere.md", "# Hidden\n");
  await f.write("work", "_internal/Secret.md", "# Secret\n");
  await f.write("ai", "Parity.md", PARITY_NOTE);
  await f.write("ai", "Gallery.md", "# Gallery\n\n![[diagram.png]]\n");
  await f.reconfigure(
    f.collections.map((c) =>
      c.name === "work" ? { ...c, exclude: ["_internal"] } : c
    )
  );
  await f.sync();
  return f;
};

describe("files outside the index (Obsidian parity)", () => {
  test("only genuinely missing targets stay unresolved; the rest is outside-index", async () => {
    fixture = await openParityFixture();
    const report = await audit(fixture);
    const of = (ruleId: string) =>
      findings(report, ruleId)
        .filter(({ subject }) => subject === "gno://ai/Parity.md")
        .map(({ detail }) => detail);
    // The escaped alias and the bracketed Markdown link resolve; a
    // non-Markdown target needs its extension, as in Obsidian.
    expect(
      of("links.local-targets")
        .map((d) => d.normalizedTarget)
        .sort()
    ).toEqual(["diagram", "nowhere"]);
    expect(
      of("links.outside-index")
        .map((d) => `${d.normalizedTarget} ${d.resolutionStatus}`)
        .sort()
    ).toEqual([
      "attachments/report.pdf outside-index",
      "diagram.png outside-index",
      "old plan outside-index",
      "secret outside-index",
    ]);
    const outsideRule = report.rules.find(
      ({ ruleId }) => ruleId === "links.outside-index"
    );
    expect(outsideRule?.status).toBe("pass");
    expect(outsideRule?.findingCount).toBe(5);
    expect(
      report.findings
        .filter(({ ruleId }) => ruleId === "links.outside-index")
        .every(({ severity }) => severity === "info")
    ).toBe(true);
    // Existence only: nothing about the excluded note beyond the link.
    expect(JSON.stringify(report)).not.toContain("_internal");
    // An outside-index link is no edge: Gallery stays an orphan.
    expect(
      findings(report, "links.orphans").map(({ subject }) => subject)
    ).toContain("gno://ai/Gallery.md");
    const excluded = fixture.store
      .getRawDb()
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM documents WHERE rel_path LIKE '_internal/%' AND active = 1"
      )
      .get();
    expect(excluded?.count).toBe(0);
  });

  test("an incomplete file listing degrades to unresolved with one diagnostic", async () => {
    fixture = await openParityFixture();
    const snapshot = captureAuditLinkSnapshot(fixture.store.getRawDb());
    const marked = await markOutsideIndexLinks(
      fixture.store.getRawDb(),
      snapshot,
      { maxFiles: 0 }
    );
    expect(marked.links.some((link) => link.outsideIndex)).toBe(false);
    const rules = evaluateLinkAudit(marked, {
      rootUris: [],
      ignorePathPrefixes: [],
    });
    const outside = rules.find(
      ({ ruleId }) => ruleId === "links.outside-index"
    );
    expect(outside?.status).toBe("pass");
    expect(outside?.findingCount).toBe(0);
    expect(outside?.message).toContain(
      "file listing of 1 link workspace was incomplete"
    );
    const local = rules.find(({ ruleId }) => ruleId === "links.local-targets");
    expect(
      local?.findings?.some(
        (finding) => finding.evidence[0]?.summary === "ai:diagram.png"
      )
    ).toBe(true);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "the listing skips hidden and unreadable folders and reports itself incomplete",
    async () => {
      fixture = await openParityFixture();
      const locked = join(fixture.vault, "Locked");
      await writeVaultFile(fixture, "Locked/Inside.md");
      await chmod(locked, 0o000);
      try {
        const listing = await listWorkspaceFiles(fixture.vault);
        expect(listing.complete).toBe(false);
        expect(listing.files).toContain("Attachments/diagram.png");
        expect(listing.files.some((path) => path.startsWith("."))).toBe(false);
        expect(listing.files).not.toContain("Locked/Inside.md");
      } finally {
        await chmod(locked, 0o755);
      }
    }
  );
});

describe("audit bounds (A13)", () => {
  test("a large tie is reported as truncated evidence within the detail bound", async () => {
    fixture = await openLinkWorkspaceFixture();
    for (let index = 0; index < 40; index += 1) {
      await fixture.write("work", `Tie${index}/Same.md`, `# Same ${index}\n`);
    }
    await fixture.write("ai", "Linker.md", "# Linker\n\n[[Same]]\n");
    await fixture.sync();
    const report = await audit(fixture);
    const tie = report.findings.find((finding) =>
      finding.evidence[0]?.detail?.includes('"normalizedTarget":"same"')
    );
    const detail = tie?.evidence[0]?.detail ?? "";
    expect(Array.from(detail).length).toBeLessThanOrEqual(512);
    expect(JSON.parse(detail)).toMatchObject({
      candidateCount: 40,
      candidatesTruncated: true,
    });
    expect(report.truncation.evidenceTruncated).toBe(true);
  });

  test("50,001 links truncate the snapshot; findings above 1,000 stay countable", async () => {
    fixture = await openLinkWorkspaceFixture();
    const sourceId = fixture.docId("gno://plain/Other.md");
    const links = Array.from({ length: 50_001 }, (_, index) => ({
      targetRef: `Missing ${index}`,
      targetRefNorm: `missing ${index}`,
      linkType: "wiki" as const,
      startLine: index + 1,
      startCol: 1,
      endLine: index + 1,
      endCol: 12,
    }));
    const stored = await fixture.store.setDocLinks(sourceId, links, "parsed");
    expect(stored.ok).toBe(true);
    const snapshot = captureAuditLinkSnapshot(fixture.store.getRawDb());
    expect(snapshot.truncated.links).toBe(true);
    expect(snapshot.totals.links).toBeGreaterThan(50_000);
    const rules = evaluateLinkAudit(snapshot, {
      rootUris: [],
      ignorePathPrefixes: [],
      maxFindingsPerRule: 2000,
    });
    const local = rules.find((rule) => rule.ruleId === "links.local-targets");
    expect(local).toMatchObject({
      status: "inconclusive",
      skipReason: "snapshot_truncated",
    });
    expect(local?.findings).toHaveLength(2000);
    expect(local?.findingCount).toBeGreaterThan(1000);
  });
});
