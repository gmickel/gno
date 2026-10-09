/**
 * Opt-in collection link rules: links.policy, links.external-url and
 * paths.pattern. Without the collection keys the report is unchanged.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";
import type { AuditRunResult } from "../../src/core/audit";

import schema from "../../spec/output-schemas/audit-report.schema.json";
import { CollectionSchema, ConfigSchema } from "../../src/config/types";
import { AUDIT_EXIT_CODES } from "../../src/core/audit-contract";
import { findExternalUrls } from "../../src/core/audit-links";
import { runWorkspaceAudit } from "../../src/core/audit-workspace";
import {
  openLinkWorkspaceFixture,
  type LinkWorkspaceFixture,
} from "../fixtures/link-workspace/fixture";

let fixture: LinkWorkspaceFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const BASE_LINK_RULES = [
  "links.ambiguous-targets",
  "links.local-targets",
  "links.orphans",
  "links.outside-index",
  "links.parser-boundary",
];

const withRules = (
  f: LinkWorkspaceFixture,
  rules: Record<string, Partial<Collection>>
): Collection[] =>
  f.collections.map((collection) => ({
    ...collection,
    ...rules[collection.name],
  }));

const audit = async (
  f: LinkWorkspaceFixture,
  collections: Collection[] = f.collections
): Promise<Extract<AuditRunResult, { ok: true }>> => {
  const result = await runWorkspaceAudit({
    store: f.store,
    config: ConfigSchema.parse({ version: "1.0", collections }),
    collections,
    indexName: "default",
    categories: ["links"],
    maxFindings: "all",
  });
  if (!result.ok) throw new Error(result.error);
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  expect(validate(result.report), JSON.stringify(validate.errors)).toBe(true);
  return result;
};

const ruleIds = (result: Extract<AuditRunResult, { ok: true }>) =>
  result.report.rules.map(({ ruleId }) => ruleId).sort();

const findingsOf = (
  result: Extract<AuditRunResult, { ok: true }>,
  ruleId: string
) => result.report.findings.filter((finding) => finding.ruleId === ruleId);

describe("opt-in collection link rules", () => {
  test("with no new keys set the rule list and fingerprints are unchanged", async () => {
    fixture = await openLinkWorkspaceFixture();
    const before = await audit(fixture);
    expect(ruleIds(before)).toEqual(BASE_LINK_RULES);
    const explicitNone = await audit(
      fixture,
      withRules(fixture, { work: { linkPolicy: undefined } })
    );
    expect(explicitNone.report.fingerprints.config).toBe(
      before.report.fingerprints.config
    );
  });

  test("a link to a collection outside mayLinkTo is a links.policy finding (exit 4)", async () => {
    fixture = await openLinkWorkspaceFixture();
    // work/Roadmap.md links to ai's Planner and Private.
    const denied = await audit(
      fixture,
      withRules(fixture, { work: { linkPolicy: { mayLinkTo: [] } } })
    );
    expect(ruleIds(denied)).toContain("links.policy");
    const policy = denied.report.rules.find(
      ({ ruleId }) => ruleId === "links.policy"
    );
    expect(policy?.status).toBe("fail");
    const findings = findingsOf(denied, "links.policy");
    expect(findings.map(({ subject }) => subject)).toEqual([
      "gno://work/Roadmap.md",
      "gno://work/Roadmap.md",
    ]);
    expect(
      findings
        .map(
          ({ evidence }) =>
            (JSON.parse(evidence[0]?.detail ?? "{}") as { target: string })
              .target
        )
        .sort()
    ).toEqual(["ai:Agents/Planner.md", "ai:Private.md"]);
    expect(denied.exit).toBe("findings");
    expect(AUDIT_EXIT_CODES[denied.exit]).toBe(4);
    // Same-collection links and other collections' links are never policy
    // findings; allowing ai clears the rule.
    const allowed = await audit(
      fixture,
      withRules(fixture, { work: { linkPolicy: { mayLinkTo: ["ai"] } } })
    );
    expect(findingsOf(allowed, "links.policy")).toEqual([]);
    expect(
      allowed.report.rules.find(({ ruleId }) => ruleId === "links.policy")
        ?.status
    ).toBe("pass");
  });

  test("external URLs are findings only when the collection denies them", async () => {
    fixture = await openLinkWorkspaceFixture();
    await fixture.write(
      "plain",
      "Sources.md",
      [
        "---",
        "source: https://front.example/ignored",
        "---",
        "# Sources",
        "",
        "See https://example.com/a. and <mailto:team@example.com>.",
        "Internal gno://plain/Home.md is fine.",
        "",
        "```",
        "https://code.example/ignored",
        "```",
        "",
      ].join("\n")
    );
    await fixture.sync();
    const off = await audit(fixture);
    expect(ruleIds(off)).not.toContain("links.external-url");
    const on = await audit(
      fixture,
      withRules(fixture, { plain: { linkPolicy: { externalUrls: "deny" } } })
    );
    const findings = findingsOf(on, "links.external-url");
    expect(
      findings.map(({ evidence }) => evidence[0]?.summary ?? "").sort()
    ).toEqual(["https://example.com/a", "mailto:team@example.com"]);
    expect(
      findings.every(({ subject }) => subject.startsWith("gno://plain/"))
    ).toBe(true);
    expect(on.exit).toBe("findings");
  });

  test("paths.pattern reports document paths that do not match", async () => {
    fixture = await openLinkWorkspaceFixture();
    await fixture.write("plain", "good-slug.md", "# Good\n\n[[Home]]\n");
    await fixture.sync();
    const result = await audit(
      fixture,
      withRules(fixture, { plain: { pathPattern: "^[a-z0-9-]{1,80}\\.md$" } })
    );
    expect(
      findingsOf(result, "paths.pattern")
        .map(({ subject }) => subject)
        .sort()
    ).toEqual([
      "gno://plain/Home.md",
      "gno://plain/Other.md",
      "gno://plain/Titled.md",
    ]);
    expect(result.exit).toBe("findings");
  });
});

describe("collection config and URL scanning", () => {
  test("pathPattern must compile and mayLinkTo must name collections", () => {
    const base = { name: "pages", path: "/tmp/pages" };
    expect(
      CollectionSchema.safeParse({ ...base, pathPattern: "(" }).success
    ).toBe(false);
    expect(
      CollectionSchema.safeParse({
        ...base,
        linkPolicy: { mayLinkTo: ["Not A Name"] },
      }).success
    ).toBe(false);
    expect(
      CollectionSchema.safeParse({
        ...base,
        linkPolicy: { mayLinkTo: ["org"], externalUrls: "deny" },
        pathPattern: "^[a-z0-9-]{1,80}\\.md$",
      }).success
    ).toBe(true);
  });

  test("findExternalUrls skips frontmatter, code and gno:// URIs", () => {
    expect(
      findExternalUrls(
        "---\nurl: https://a.example\n---\nText `https://b.example` and [x](https://c.example/p), ftp://d.example.\n"
      )
    ).toEqual([
      { url: "https://c.example/p", line: 4, column: 34 },
      { url: "ftp://d.example", line: 4, column: 56 },
    ]);
  });
});
