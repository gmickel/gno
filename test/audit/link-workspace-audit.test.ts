/**
 * Link audit over a link workspace (R7, A12, A13).
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises chmod/mkdir/symlink: filesystem structure ops, no Bun equivalent.
import { chmod, mkdir, symlink } from "node:fs/promises";
// node:path join: path algebra, no Bun equivalent.
import { join } from "node:path";

import type { AuditReport } from "../../src/core/audit";

import { ConfigSchema } from "../../src/config/types";
import { evaluateLinkAudit } from "../../src/core/audit-links";
import {
  listWorkspaceFiles,
  markOutsideIndexLinks,
  type WorkspaceFileSystem,
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
    const sorted = (values: unknown[]) =>
      values.map(String).sort((left, right) => left.localeCompare(right));
    expect(
      sorted(of("links.local-targets").map((d) => d.normalizedTarget))
    ).toEqual(["diagram", "nowhere"]);
    expect(
      sorted(
        of("links.outside-index").map((d) =>
          [d.normalizedTarget, d.resolutionStatus].map(String).join(" ")
        )
      )
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

  /** In-memory filesystem: folders by exact path, symlink targets, files. */
  const memoryFileSystem = (spec: {
    folders: Record<string, Array<[string, "file" | "dir" | "link"]>>;
    links?: Record<string, string | Error>;
    regularFiles?: string[];
  }): WorkspaceFileSystem => {
    const missing = (path: string) =>
      Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return {
      readDirectory: async (path) => {
        const entries = spec.folders[path];
        if (!entries) throw missing(path);
        return entries.map(([name, kind]) => ({
          name,
          isFile: () => kind === "file",
          isDirectory: () => kind === "dir",
          isSymbolicLink: () => kind === "link",
        }));
      },
      realPath: async (path) => {
        const target = spec.links?.[path] ?? path;
        if (target instanceof Error) throw target;
        return target;
      },
      isRegularFile: async (path) => spec.regularFiles?.includes(path) ?? false,
    };
  };

  test("folders with decomposed names are read by their on-disk name", async () => {
    const root = join("/", "ws");
    const decomposed = "Cafe\u0301";
    const listing = await listWorkspaceFiles(root, {
      fileSystem: memoryFileSystem({
        folders: {
          [root]: [[decomposed, "dir"]],
          [join(root, decomposed)]: [["Menu.png", "file"]],
        },
      }),
    });
    expect(listing).toEqual({
      files: ["Caf\u00e9/Menu.png"],
      complete: true,
    });
  });

  test.each([
    [false, true],
    [true, false],
  ])(
    "a symlink counts only when it resolves to a regular file inside the workspace (unreadable link: %p)",
    async (withDenied, complete) => {
      const root = join("/", "ws");
      const at = (name: string) => join(root, name);
      const outside = join("/", "elsewhere", "x.png");
      const links: Array<[string, string | Error]> = [
        ["good.png", at("real.png")],
        [
          "dangling.png",
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        ],
        ["folder.png", at("dir")],
        ["outside.png", outside],
        ...(withDenied
          ? ([
              [
                "denied.png",
                Object.assign(new Error("EACCES"), { code: "EACCES" }),
              ],
            ] as Array<[string, Error]>)
          : []),
      ];
      const listing = await listWorkspaceFiles(root, {
        fileSystem: memoryFileSystem({
          folders: {
            [root]: [
              ["real.png", "file"],
              ["dir", "dir"],
              ...links.map(([name]) => [name, "link"] as [string, "link"]),
            ],
            [at("dir")]: [],
          },
          links: Object.fromEntries(
            links.map(([name, target]) => [at(name), target])
          ),
          regularFiles: [at("real.png"), outside],
        }),
      });
      expect(listing.files.sort((l, r) => l.localeCompare(r))).toEqual([
        "good.png",
        "real.png",
      ]);
      // Missing or foreign targets are not files; only a read error makes
      // the listing incomplete.
      expect(listing.complete).toBe(complete);
    }
  );

  test.skipIf(process.platform === "win32")(
    "on disk, dangling and folder symlinks are not listed as files",
    async () => {
      fixture = await openParityFixture();
      const at = (relPath: string) => join(fixture!.vault, relPath);
      await symlink(at("Attachments/diagram.png"), at("Attachments/alias.png"));
      await symlink(at("Attachments/gone.png"), at("Attachments/dangling.png"));
      await symlink(at("Archive"), at("Attachments/folder.png"));
      const listing = await listWorkspaceFiles(fixture.vault);
      expect(listing.files).toContain("Attachments/alias.png");
      expect(listing.files).not.toContain("Attachments/dangling.png");
      expect(listing.files).not.toContain("Attachments/folder.png");
      expect(listing.complete).toBe(true);
    }
  );

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

const RESIDUE_LOG = [
  "# Log",
  "",
  "- Pressed the ` key by mistake.",
  "- Documented the syntax as `[[Note Syntax]]` today.",
  "",
  "```md",
  "[[Fenced Example]]",
  "```",
  "",
  "Genuinely missing: [[Nowhere Else]]",
  "",
  "[[Half written",
  "- next bullet ]]",
  "",
].join("\n");

const openResidueFixture = async (): Promise<LinkWorkspaceFixture> => {
  const f = await openLinkWorkspaceFixture();
  await f.write("ai", "Log.md", RESIDUE_LOG);
  await f.write(
    "ai",
    "scripts/render.py",
    'LINK = f"[[{stem}{anc}]]"\nCASE = "[[Cross Link Target\\\\|x]]"\n'
  );
  await f.write(
    "work",
    "Skills/Tool/SKILL.md",
    "# Tool\n\n[scripts/doctor.sh](scripts/doctor.sh) [gone](scripts/gone.sh)\n"
  );
  await f.write("work", "Skills/Tool/scripts/doctor.sh", "#!/bin/sh\n");
  await f.reconfigure(
    f.collections.map((c) => (c.name === "ai" ? { ...c, pattern: "**/*" } : c))
  );
  await f.sync();
  return f;
};

describe("residual link noise (code, non-Markdown sources, unindexed files)", () => {
  test("only the unclosed link and missing targets stay unresolved", async () => {
    fixture = await openResidueFixture();
    const report = await audit(fixture);
    const residue = (ruleId: string) =>
      findings(report, ruleId).filter(({ subject }) =>
        [
          "gno://ai/Log.md",
          "gno://ai/scripts/render.py",
          "gno://work/Skills/Tool/SKILL.md",
        ].includes(subject)
      );
    expect(
      residue("links.local-targets")
        .map(
          ({ subject, detail }) =>
            `${subject} ${String(detail.normalizedTarget)}`
        )
        .sort()
    ).toEqual(
      [
        "gno://ai/Log.md half written\n- next bullet",
        "gno://ai/Log.md nowhere else",
        "gno://work/Skills/Tool/SKILL.md Skills/Tool/scripts/gone.sh",
      ].sort()
    );
    expect(
      residue("links.outside-index").map(({ subject, detail }) => [
        subject,
        detail.normalizedTarget,
        detail.referenceKind,
      ])
    ).toEqual([
      [
        "gno://work/Skills/Tool/SKILL.md",
        "Skills/Tool/scripts/doctor.sh",
        "markdown",
      ],
    ]);
    // The Python file stays indexed and searchable; it just has no links.
    const script = fixture.store
      .getRawDb()
      .query<{ links: number }, [number]>(
        "SELECT COUNT(*) AS links FROM doc_links WHERE source_doc_id = ?"
      )
      .get(fixture.docId("gno://ai/scripts/render.py"));
    expect(script?.links).toBe(0);
    // Existence only: the unindexed script is never a document.
    expect(() =>
      fixture?.docId("gno://work/Skills/Tool/scripts/doctor.sh")
    ).toThrow();
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
