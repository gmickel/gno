/**
 * Link audit over a link workspace (R7, A12, A13).
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { AuditReport } from "../../src/core/audit";

import { ConfigSchema } from "../../src/config/types";
import { evaluateLinkAudit } from "../../src/core/audit-links";
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
      candidateCount: 2,
      candidates: [],
      candidatesWithheld: 2,
    });
    expect(JSON.stringify(aiOnly.findings)).not.toContain("gno://work/");
  });
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
