/**
 * Opt-in collection audit rules: links.collection-policy, links.external-url,
 * links.path-layout (fn-225).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises mkdir/mkdtemp: directory structure ops, no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent.
import { tmpdir } from "node:os";
// node:path join: path algebra, no Bun equivalent.
import { join } from "node:path";

import type { AuditReport } from "../../src/core/audit";
import type { ToolContext } from "../../src/mcp/server";
import type { DocumentRow } from "../../src/store/types";

import { getConfigPath, getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import { loadConfig } from "../../src/config";
import { ConfigSchema } from "../../src/config/types";
import { hashAuditCanonical } from "../../src/core/audit";
import {
  evaluateCollectionAuditRules,
  findExternalUrls,
} from "../../src/core/audit-collection-rules";
import { Mutex } from "../../src/mcp/context";
import { auditInputSchema, handleAudit } from "../../src/mcp/tools/audit";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const POLICY = "links.collection-policy";
const EXTERNAL = "links.external-url";
const LAYOUT = "links.path-layout";
const NEW_RULES = [POLICY, EXTERNAL, LAYOUT];

const POST = `---
title: Post
source: https://frontmatter.example/skip
---

# Post

Allowed: [[reference:Ref]] and [[Post2]]. Not allowed: [[private:Secret]].
Read https://example.com/a. Or [the site](https://example.org/b), not
gno://reference/Ref.md or file:///tmp/local.

Inline \`https://code.example/skip\` stays out.

<!-- https://comment.example/skip -->

\`\`\`
https://fenced.example/skip
\`\`\`
`;

let root: string;
let stdout = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const previousEnvironment: Record<string, string | undefined> = {};

const cli = async (...args: string[]) => {
  stdout = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (): boolean => true;
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
};

const auditJson = async (...args: string[]) => {
  const result = await cli("audit", "links", "--json", ...args);
  return {
    code: result.code,
    report: JSON.parse(result.stdout) as AuditReport,
  };
};

const writeConfig = async (
  mutate: (config: Record<string, unknown>) => void
): Promise<void> => {
  const path = getConfigPath();
  const config = Bun.YAML.parse(await Bun.file(path).text()) as Record<
    string,
    unknown
  >;
  mutate(config);
  await Bun.write(path, Bun.YAML.stringify(config));
};

const PUBLISHED_AUDIT = {
  linkCollections: ["reference"],
  externalUrls: "report",
  paths: ["20??/**/*.md"],
};

const setAudit = (audit: Record<string, unknown> | undefined) =>
  writeConfig((config) => {
    const collections = config.collections as Array<Record<string, unknown>>;
    const published = collections.find(({ name }) => name === "published");
    if (!published) throw new Error("published collection missing");
    if (audit === undefined) delete published.audit;
    else published.audit = audit;
  });

const ruleFindings = (report: AuditReport, ruleId: string) =>
  report.findings
    .filter((finding) => finding.ruleId === ruleId)
    .map(({ subject, location, evidence }) => ({
      subject,
      location,
      summary: evidence[0]?.summary,
    }));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-audit-rules-"));
  for (const name of ["GNO_CONFIG_DIR", "GNO_DATA_DIR", "GNO_CACHE_DIR"]) {
    previousEnvironment[name] = process.env[name];
  }
  process.env.GNO_CONFIG_DIR = join(root, "config");
  process.env.GNO_DATA_DIR = join(root, "data");
  process.env.GNO_CACHE_DIR = join(root, "cache");
  const published = join(root, "published");
  await mkdir(join(published, "2026"), { recursive: true });
  await mkdir(join(root, "reference"), { recursive: true });
  await mkdir(join(root, "private"), { recursive: true });
  await Bun.write(join(published, "2026", "Post.md"), POST);
  await Bun.write(join(published, "2026", "Post2.md"), "# Post2\n\n[[Post]]\n");
  await Bun.write(
    join(published, "Loose.md"),
    "# Loose\n\n[[reference:Ref]] [[private:Secret]]\n"
  );
  await Bun.write(join(root, "reference", "Ref.md"), "# Ref\n");
  await Bun.write(join(root, "private", "Secret.md"), "# Secret\n");
  expect((await cli("init", published, "--name", "published")).code).toBe(0);
  for (const name of ["reference", "private"]) {
    expect(
      (await cli("collection", "add", join(root, name), "--name", name)).code
    ).toBe(0);
  }
  expect((await cli("index", "--no-embed")).code).toBe(0);
}, 60_000);

afterAll(async () => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await safeRm(root);
});

describe("collection audit rules", () => {
  test("without an audit block, no new rule appears and the config fingerprint keeps its old shape", async () => {
    const { code, report } = await auditJson();
    expect(report.rules.map(({ ruleId }) => ruleId)).not.toContain(POLICY);
    expect(report.rules.some(({ ruleId }) => NEW_RULES.includes(ruleId))).toBe(
      false
    );
    const loaded = await loadConfig();
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(report.fingerprints.config).toBe(
      hashAuditCanonical({
        collections: loaded.value.collections.map(
          ({ name, path, pattern }) => ({ name, path, pattern })
        ),
        filters: { collections: [], paths: [], tags: [] },
      })
    );
    // Links between collections are fine without configuration.
    expect(report.findings.some(({ ruleId }) => ruleId === POLICY)).toBe(false);
    expect([0, 4]).toContain(code);
  });

  test("linkCollections reports links into unlisted collections only", async () => {
    await setAudit(PUBLISHED_AUDIT);
    const { code, report } = await auditJson();
    expect(code).toBe(4);
    expect(ruleFindings(report, POLICY)).toEqual([
      {
        subject: "gno://published/2026/Post.md",
        location: "L8:C56",
        summary: "private:gno://private/Secret.md",
      },
      {
        subject: "gno://published/Loose.md",
        location: "L3:C19",
        summary: "private:gno://private/Secret.md",
      },
    ]);
    const rule = report.rules.find(({ ruleId }) => ruleId === POLICY);
    expect(rule).toMatchObject({ category: "links", status: "fail" });
    expect(
      report.findings.find(({ ruleId }) => ruleId === POLICY)?.severity
    ).toBe("warning");
  });

  test("externalUrls: report lists URLs in text, skipping frontmatter, code, comments and local schemes", async () => {
    const { report } = await auditJson("-c", "published");
    // Findings sort by location text, as every audit rule's do.
    expect(ruleFindings(report, EXTERNAL)).toEqual([
      {
        subject: "gno://published/2026/Post.md",
        location: "L9:C43",
        summary: "https://example.org/b",
      },
      {
        subject: "gno://published/2026/Post.md",
        location: "L9:C6",
        summary: "https://example.com/a",
      },
    ]);
  });

  test("paths reports documents outside the globs", async () => {
    const { report } = await auditJson();
    expect(ruleFindings(report, LAYOUT)).toEqual([
      {
        subject: "gno://published/Loose.md",
        location: null,
        summary: "Loose.md",
      },
    ]);
  });

  test("a run scoped to collections without configuration emits no new rules", async () => {
    const { report } = await auditJson("-c", "reference");
    expect(report.rules.some(({ ruleId }) => NEW_RULES.includes(ruleId))).toBe(
      false
    );
  });

  test("gno_audit over MCP returns the same rule results as the CLI", async () => {
    const { report: viaCli } = await auditJson();
    const loaded = await loadConfig();
    if (!loaded.ok) throw new Error(loaded.error.message);
    const store = new SqliteAdapter();
    const opened = store.openReadOnly(getIndexDbPath());
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const result = await handleAudit(
        auditInputSchema.parse({ category: "links", maxFindings: 100 }),
        {
          store,
          config: loaded.value,
          collections: loaded.value.collections,
          actualConfigPath: getConfigPath(),
          indexName: "default",
          toolMutex: new Mutex(),
          jobManager: {},
          serverInstanceId: "audit-rules-test",
          writeLockPath: join(root, ".lock"),
          enableWrite: false,
          isShuttingDown: () => false,
        } as unknown as ToolContext
      );
      const viaMcp = result.structuredContent as unknown as AuditReport;
      const summary = (report: AuditReport) => ({
        rules: report.rules
          .filter(({ ruleId }) => NEW_RULES.includes(ruleId))
          .map(({ ruleId, status, findingCount }) => ({
            ruleId,
            status,
            findingCount,
          })),
        findings: report.findings
          .filter(({ ruleId }) => NEW_RULES.includes(ruleId))
          .map(({ id }) => id),
      });
      expect(summary(viaMcp)).toEqual(summary(viaCli));
      expect(summary(viaMcp).rules).toHaveLength(3);
    } finally {
      await store.close();
    }
  });

  test("the audit block changes the config fingerprint only where present", async () => {
    const { report } = await auditJson();
    const loaded = await loadConfig();
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(report.fingerprints.config).toBe(
      hashAuditCanonical({
        collections: loaded.value.collections.map(
          ({ name, path, pattern, audit }) => ({
            name,
            path,
            pattern,
            ...(audit === undefined ? {} : { audit }),
          })
        ),
        filters: { collections: [], paths: [], tags: [] },
      })
    );
  });

  test("the rules never change retrieval or link resolution", async () => {
    await setAudit(undefined);
    const before = await cli("search", "Secret", "--json");
    const linksBefore = await cli(
      "links",
      "gno://published/Loose.md",
      "--json"
    );
    await setAudit(PUBLISHED_AUDIT);
    const after = await cli("search", "Secret", "--json");
    const linksAfter = await cli("links", "gno://published/Loose.md", "--json");
    expect(after.code).toBe(before.code);
    expect(JSON.parse(after.stdout).results).toEqual(
      JSON.parse(before.stdout).results
    );
    expect(linksAfter).toEqual(linksBefore);
  });
});

describe("collection audit config validation", () => {
  const base = (audit: unknown, names = ["published", "reference"]) => ({
    version: "1.0",
    collections: names.map((name) => ({
      name,
      path: `/tmp/${name}`,
      ...(name === "published" ? { audit } : {}),
    })),
  });
  const issues = (audit: unknown) => {
    const parsed = ConfigSchema.safeParse(base(audit));
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
  };

  test("accepts a valid audit block", () => {
    expect(issues(PUBLISHED_AUDIT)).toEqual([]);
  });

  test("an unknown linkCollections name is an error naming it", () => {
    expect(issues({ linkCollections: ["reference", "ghost"] })).toEqual([
      'Collection "published" audit.linkCollections names unknown collection "ghost"',
    ]);
  });

  test("externalUrls accepts only report or ignore", () => {
    expect(issues({ externalUrls: "deny" })).toHaveLength(1);
    expect(issues({ externalUrls: "ignore" })).toEqual([]);
  });

  test("paths must be a non-empty list of valid globs", () => {
    expect(issues({ paths: [] })).toEqual([
      "audit.paths must list at least one glob",
    ]);
    for (const glob of ["{a,b", "a/[b", "../x/*.md", "/abs/*.md", ""]) {
      expect(issues({ paths: [glob] })).toHaveLength(1);
    }
  });

  test("unknown audit keys are rejected", () => {
    expect(issues({ linkPolicy: ["reference"] })).toHaveLength(1);
  });

  test("an invalid config fails gno audit with the message", async () => {
    await writeConfig((config) => {
      const collections = config.collections as Array<Record<string, unknown>>;
      const published = collections.find(({ name }) => name === "published");
      if (published) published.audit = { linkCollections: ["ghost"] };
    });
    const result = await cli("audit", "links", "--json");
    expect(result.code).toBe(1);
    await setAudit(PUBLISHED_AUDIT);
  });
});

describe("collection audit rule units", () => {
  const document = (overrides: Partial<DocumentRow>): DocumentRow =>
    ({
      id: 1,
      uri: "gno://published/2026/a.md",
      collection: "published",
      relPath: "2026/a.md",
      recordSourcePath: null,
      mirrorHash: "m1",
      ...overrides,
    }) as DocumentRow;
  const input = (overrides: Record<string, unknown>) => ({
    links: {
      documents: [],
      links: [],
      totals: { documents: 0, links: 0 },
      truncated: { documents: false, links: false },
      metrics: {
        documentRowsExamined: 0,
        linkRowsExamined: 0,
        uniqueTargetsResolved: 0,
        batchedResolution: true as const,
      },
    },
    documents: [document({})],
    collections: [
      {
        name: "published",
        path: "/p",
        pattern: "**/*",
        include: [],
        exclude: [],
        audit: PUBLISHED_AUDIT,
      },
    ] as never,
    auditedCollections: ["published"],
    contents: new Map<string, string>(),
    truncated: false,
    maxFindingsPerRule: 100,
    ...overrides,
  });

  test("a document without indexed text is reported unchecked, never passing", () => {
    const rules = evaluateCollectionAuditRules(input({}));
    const external = rules.find(({ ruleId }) => ruleId === EXTERNAL);
    expect(external?.status).toBe("fail");
    expect(external?.findings?.[0]?.evidence[0]?.kind).toBe(
      "external-url-unchecked"
    );
  });

  test("a truncated snapshot makes every configured rule inconclusive", () => {
    const rules = evaluateCollectionAuditRules(input({ truncated: true }));
    expect(rules.map(({ ruleId, status }) => [ruleId, status])).toEqual([
      [POLICY, "inconclusive"],
      [EXTERNAL, "inconclusive"],
      [LAYOUT, "inconclusive"],
    ]);
  });

  test("URL extraction trims prose punctuation and keeps balanced parentheses", () => {
    expect(
      findExternalUrls(
        "See (https://a.example/x), https://en.wikipedia.org/wiki/A_(b). <https://c.example/>"
      ).map(({ url }) => url)
    ).toEqual([
      "https://a.example/x",
      "https://en.wikipedia.org/wiki/A_(b)",
      "https://c.example/",
    ]);
  });
});
