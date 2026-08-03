import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import schema from "../../spec/output-schemas/audit-report.schema.json";
import {
  auditExitCode,
  buildAuditFindingId,
  canonicalAuditJson,
  createAuditWriteGuard,
  runAudit,
  serializeAuditReportSemantic,
  type AuditCapabilitySnapshot,
  type AuditFingerprints,
  type AuditRuleContribution,
  type AuditScope,
} from "../../src/core/audit";

const scope: AuditScope = {
  categories: [],
  collections: ["work"],
  paths: [],
  tags: [],
  indexName: "default",
};

const capabilities: AuditCapabilitySnapshot = {
  indexReadable: true,
  sourcesReadable: true,
  linksGraphAvailable: true,
  provenanceSchemaAvailable: true,
  offline: true,
  llmDisabled: true,
};

const fingerprints: AuditFingerprints = {
  config: "config-v1",
  source: "source-v1",
  index: "index-v1",
  rules: "rules-v1",
};

const finding = (subject: string): AuditRuleContribution => ({
  ruleId: "links.unresolved",
  category: "links",
  status: "fail",
  message: "Unresolved links found",
  examinedCount: 2,
  findings: [
    {
      subject,
      location: "L2",
      severity: "warning",
      message: "Target cannot be resolved",
      evidence: [{ kind: "target", summary: "Missing Note", path: "a.md" }],
      guidance: ["Create the target or correct the link"],
    },
  ],
});

const deterministicClock = (): (() => Date) => {
  const values = [
    new Date("2026-08-03T12:00:00.000Z"),
    new Date("2026-08-03T12:00:01.000Z"),
  ];
  return () => values.shift() ?? new Date("2026-08-03T12:00:01.000Z");
};

const deterministicMonotonic = (): (() => number) => {
  let value = 0;
  return () => value++;
};

describe("knowledge integrity audit contract", () => {
  test("canonicalizes traversal permutations to identical semantic JSON", async () => {
    const run = async (subjects: string[]) =>
      runAudit({
        scope,
        capabilities,
        captureFingerprints: () => fingerprints,
        rules: subjects.map((subject) => () => finding(subject)),
        clock: deterministicClock(),
        monotonicNow: deterministicMonotonic(),
        gnoVersion: "1.33.0",
      });

    const first = await run(["gno://work/z.md", "gno://work/a.md"]);
    const second = await run(["gno://work/a.md", "gno://work/z.md"]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    expect(serializeAuditReportSemantic(first.report)).toBe(
      serializeAuditReportSemantic(second.report)
    );
    expect(first.report.findings.map(({ id }) => id)).toEqual(
      second.report.findings.map(({ id }) => id)
    );
    expect(first.exit).toBe("findings");
    expect(auditExitCode(first.exit)).toBe(4);
  });

  test("load-bearing evidence changes the stable finding identity", () => {
    const common = {
      ruleId: "links.unresolved",
      subject: "gno://work/a.md",
      location: "L2",
    };
    expect(
      buildAuditFindingId({ ...common, evidenceFingerprint: "evidence-a" })
    ).not.toBe(
      buildAuditFindingId({ ...common, evidenceFingerprint: "evidence-b" })
    );
  });

  test("bounds identifier-bearing finding fields to the closed schema", async () => {
    const oversized = "x".repeat(3000);
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => fingerprints,
      rules: [
        () => ({
          ruleId: oversized,
          category: "links",
          status: "fail",
          message: "Oversized identifier evidence",
          findings: [
            {
              subject: oversized,
              location: oversized,
              severity: "warning",
              message: "Bound every identifier",
              evidence: [
                {
                  kind: oversized,
                  summary: "Oversized indexed path",
                  uri: oversized,
                  path: oversized,
                },
              ],
            },
          ],
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [materialized] = result.report.findings;
    expect(materialized?.ruleId).toHaveLength(128);
    expect(materialized?.subject).toHaveLength(2048);
    expect(materialized?.location).toHaveLength(2048);
    expect(materialized?.evidence[0]?.kind).toHaveLength(128);
    expect(materialized?.evidence[0]?.uri).toHaveLength(2048);
    expect(materialized?.evidence[0]?.path).toHaveLength(2048);

    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(result.report), JSON.stringify(validate.errors)).toBe(true);
  });

  test("bounded retries report changed_during_audit and never clean", async () => {
    let capture = 0;
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => ({
        ...fingerprints,
        source: `source-${capture++}`,
      }),
      rules: [
        () => ({
          ruleId: "freshness.source-index",
          category: "freshness",
          status: "pass",
          message: "No drift observed in the sampled snapshot",
        }),
      ],
      clock: deterministicClock(),
      monotonicNow: deterministicMonotonic(),
      maxAttempts: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.status).toBe("changed_during_audit");
    expect(result.exit).toBe("partial");
    expect(auditExitCode(result.exit)).toBe(5);
  });

  test("cancellation skips pending fingerprint passes", async () => {
    const beforeStart = new AbortController();
    beforeStart.abort();
    let captures = 0;
    const cancelledBeforeStart = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => {
        captures += 1;
        return fingerprints;
      },
      rules: [],
      signal: beforeStart.signal,
    });
    expect(captures).toBe(0);
    expect(cancelledBeforeStart.ok).toBe(true);
    if (cancelledBeforeStart.ok) {
      expect(cancelledBeforeStart.report.status).toBe("partial");
      expect(cancelledBeforeStart.report.rules[0]).toMatchObject({
        ruleId: "audit.cancelled",
        skipReason: "cancelled",
      });
    }

    const duringRules = new AbortController();
    const cancelledDuringRules = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => {
        captures += 1;
        return fingerprints;
      },
      rules: [
        () => {
          duringRules.abort();
          return {
            ruleId: "links.local-targets",
            category: "links",
            status: "pass",
            message: "Temporary result",
          };
        },
      ],
      signal: duringRules.signal,
    });
    expect(captures).toBe(1);
    expect(cancelledDuringRules.ok).toBe(true);
    if (cancelledDuringRules.ok) {
      expect(cancelledDuringRules.report.status).toBe("partial");
      expect(cancelledDuringRules.report.rules).toEqual([
        expect.objectContaining({ ruleId: "audit.cancelled" }),
      ]);
    }
  });

  test("unavailable evidence is partial rather than healthy", async () => {
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => fingerprints,
      rules: [
        () => ({
          ruleId: "provenance.requirements",
          category: "provenance",
          status: "unavailable",
          message: "No declared provenance schema",
          skipReason: "schema_unavailable",
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.status).toBe("partial");
    expect(result.exit).toBe("partial");
  });

  test("runner failures return a versioned failed report and runtime exit", async () => {
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => {
        throw new Error("fingerprint source unavailable");
      },
      rules: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.status).toBe("failed");
    expect(result.report.rules).toEqual([
      expect.objectContaining({
        ruleId: "audit.runner",
        status: "unavailable",
        message: "fingerprint source unavailable",
      }),
    ]);
    expect(result.exit).toBe("runtime");
    expect(auditExitCode(result.exit)).toBe(2);
  });

  test("rejects invalid limits before evaluating rules", async () => {
    let evaluated = false;
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => fingerprints,
      rules: [
        () => {
          evaluated = true;
          return finding("gno://work/a.md");
        },
      ],
      maxFindings: 0,
    });
    expect(result).toEqual({
      ok: false,
      exit: "invalid",
      error: "maxFindings must be an integer between 1 and 1000",
    });
    expect(evaluated).toBe(false);
  });

  test("matches the closed JSON schema and proves no write attempt", async () => {
    const source = { read: () => "snapshot" };
    const sourceKeysBefore = Object.keys(source);
    const port = createAuditWriteGuard(source);
    const result = await runAudit({
      scope,
      capabilities,
      captureFingerprints: () => fingerprints,
      rules: [
        () => ({
          ruleId: "links.clean",
          category: "links",
          status: "pass",
          message: "No unresolved links",
          examinedCount: 1,
        }),
      ],
      clock: deterministicClock(),
      monotonicNow: deterministicMonotonic(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(result.report), JSON.stringify(validate.errors)).toBe(true);
    expect(port.writeAttempts).toEqual([]);
    expect(Object.keys(source)).toEqual(sourceKeysBefore);
    expect(Object.hasOwn(source, "writeAttempts")).toBe(false);
    expect(result.exit).toBe("clean");
    expect(canonicalAuditJson(result.report)).toContain(
      '"schemaVersion":"1.0"'
    );
  });
});
