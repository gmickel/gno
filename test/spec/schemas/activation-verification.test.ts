import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const GENERATED_AT = "2026-07-22T10:00:00.000Z";
const STARTED_AT = "2026-07-22T09:59:59.000Z";
const CONNECTOR_TARGET = `mcp:cursor:user:${"e".repeat(64)}`;

const timedStage = (
  status: "passed" | "failed" | "skipped",
  code?: string
) => ({
  status,
  startedAt: STARTED_AT,
  completedAt: GENERATED_AT,
  latencyMs: 4,
  ...(code ? { code } : {}),
});

const pendingSemantic = {
  status: "pending",
  startedAt: null,
  completedAt: null,
  latencyMs: null,
  code: "semantic_not_checked",
};

const connectorNotRequested = {
  status: "skipped",
  startedAt: null,
  completedAt: null,
  latencyMs: null,
  code: "connector_not_requested",
};

const validReceipt = {
  schemaVersion: "1.0",
  collection: "notes",
  fingerprint: "a".repeat(64),
  ready: true,
  generatedAt: GENERATED_AT,
  stages: {
    index: timedStage("passed"),
    lexical: timedStage("passed"),
    semantic: pendingSemantic,
    connector: connectorNotRequested,
  },
  evidence: {
    probeHash: "b".repeat(64),
    resultUri: "gno://notes/proof.md",
    resultSourceHash: "c".repeat(64),
  },
};

const withIndexFailure = (code: "no_documents" | "index_out_of_sync") => ({
  ...validReceipt,
  ready: false,
  stages: {
    ...validReceipt.stages,
    index: timedStage("failed", code),
    lexical: {
      status: "skipped",
      startedAt: null,
      completedAt: GENERATED_AT,
      latencyMs: null,
      code,
    },
  },
  evidence: {},
});

const withLexicalFailure = (
  code: "no_probe_term" | "index_query_failed" | "retrieval_mismatch"
) => ({
  ...validReceipt,
  ready: false,
  stages: {
    ...validReceipt.stages,
    lexical: timedStage("failed", code),
  },
  evidence: code === "retrieval_mismatch" ? { probeHash: "b".repeat(64) } : {},
});

const withConnector = (
  status: "passed" | "failed" | "skipped",
  code?: string
) => ({
  ...validReceipt,
  stages: {
    ...validReceipt.stages,
    connector: timedStage(status, code),
  },
  evidence: {
    ...validReceipt.evidence,
    connectorTarget: CONNECTOR_TARGET,
  },
});

describe("activation verification schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("activation-verification");
  });

  test("accepts every canonical shipped stage status and code", () => {
    const canonicalReceipts = [
      validReceipt,
      ...(["no_documents", "index_out_of_sync"] as const).map(withIndexFailure),
      ...(
        ["no_probe_term", "index_query_failed", "retrieval_mismatch"] as const
      ).map(withLexicalFailure),
      withConnector("passed"),
      ...(
        ["connector_not_configured", "target_runtime_unverifiable"] as const
      ).map((code) => withConnector("skipped", code)),
      (() => {
        const unavailable = withLexicalFailure("no_probe_term");
        return {
          ...unavailable,
          stages: {
            ...unavailable.stages,
            connector: timedStage("skipped", "connector_probe_unavailable"),
          },
          evidence: { connectorTarget: CONNECTOR_TARGET },
        };
      })(),
      ...(
        [
          "connector_probe_unavailable",
          "connector_unsupported_config",
          "connector_start_failed",
          "connector_timeout",
          "connector_missing_tools",
          "connector_status_failed",
          "connector_search_failed",
          "connector_result_mismatch",
        ] as const
      ).map((code) => withConnector("failed", code)),
    ];

    for (const receipt of canonicalReceipts) {
      expect(assertValid(receipt, schema)).toBe(true);
    }
  });

  test("rejects codes on the wrong stage or status", () => {
    const invalidStages = [
      { key: "index", value: timedStage("failed", "no_probe_term") },
      { key: "index", value: timedStage("passed", "no_documents") },
      { key: "lexical", value: timedStage("failed", "no_documents") },
      { key: "lexical", value: timedStage("passed", "retrieval_mismatch") },
      {
        key: "semantic",
        value: { ...pendingSemantic, code: "index_query_failed" },
      },
      {
        key: "semantic",
        value: { ...pendingSemantic, status: "skipped" },
      },
      {
        key: "connector",
        value: timedStage("skipped", "connector_unsupported_config"),
      },
      {
        key: "connector",
        value: timedStage("failed", "connector_not_configured"),
      },
      {
        key: "connector",
        value: timedStage("passed", "connector_timeout"),
      },
    ];

    for (const { key, value } of invalidStages) {
      expect(
        assertInvalid(
          {
            ...validReceipt,
            stages: { ...validReceipt.stages, [key]: value },
            evidence:
              key === "connector"
                ? {
                    ...validReceipt.evidence,
                    connectorTarget: CONNECTOR_TARGET,
                  }
                : validReceipt.evidence,
          },
          schema
        )
      ).toBe(true);
    }
  });

  test("rejects timing shapes that contradict stage execution", () => {
    const invalidStages = [
      {
        key: "index",
        value: { ...timedStage("passed"), startedAt: null },
      },
      {
        key: "lexical",
        value: {
          status: "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "no_documents",
        },
      },
      {
        key: "semantic",
        value: { ...pendingSemantic, completedAt: GENERATED_AT },
      },
      {
        key: "connector",
        value: { ...connectorNotRequested, latencyMs: 0 },
      },
      {
        key: "connector",
        value: {
          ...timedStage("failed", "connector_timeout"),
          latencyMs: null,
        },
      },
    ];

    for (const { key, value } of invalidStages) {
      expect(
        assertInvalid(
          {
            ...validReceipt,
            stages: { ...validReceipt.stages, [key]: value },
            evidence:
              key === "connector" && value !== connectorNotRequested
                ? {
                    ...validReceipt.evidence,
                    connectorTarget: CONNECTOR_TARGET,
                  }
                : validReceipt.evidence,
          },
          schema
        )
      ).toBe(true);
    }
  });

  test("enforces readiness as exactly index plus lexical success", () => {
    expect(assertInvalid({ ...validReceipt, ready: false }, schema)).toBe(true);
    expect(
      assertInvalid(
        { ...withLexicalFailure("no_probe_term"), ready: true },
        schema
      )
    ).toBe(true);
  });

  test("enforces connector outcomes against lexical proof availability", () => {
    const lexicalFailure = withLexicalFailure("no_probe_term");
    expect(
      assertInvalid(
        {
          ...lexicalFailure,
          stages: {
            ...lexicalFailure.stages,
            connector: timedStage("passed"),
          },
          evidence: {
            ...lexicalFailure.evidence,
            connectorTarget: CONNECTOR_TARGET,
          },
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        withConnector("skipped", "connector_probe_unavailable"),
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...lexicalFailure,
          stages: {
            ...lexicalFailure.stages,
            connector: timedStage("failed", "connector_timeout"),
          },
          evidence: {
            ...lexicalFailure.evidence,
            connectorTarget: CONNECTOR_TARGET,
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("enforces lexical evidence coherence", () => {
    for (const key of ["probeHash", "resultUri", "resultSourceHash"] as const) {
      const evidence = { ...validReceipt.evidence };
      delete evidence[key];
      expect(assertInvalid({ ...validReceipt, evidence }, schema)).toBe(true);
    }

    expect(
      assertInvalid(
        {
          ...withLexicalFailure("no_probe_term"),
          evidence: { resultUri: "gno://notes/proof.md" },
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        { ...withLexicalFailure("retrieval_mismatch"), evidence: {} },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...withLexicalFailure("retrieval_mismatch"),
          evidence: {
            probeHash: "b".repeat(64),
            resultUri: "gno://notes/proof.md",
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("requires target identity exactly for explicit connector checks", () => {
    const explicit = withConnector("failed", "connector_timeout");
    const { connectorTarget: _connectorTarget, ...withoutTarget } =
      explicit.evidence;
    expect(
      assertInvalid({ ...explicit, evidence: withoutTarget }, schema)
    ).toBe(true);
    expect(
      assertInvalid(
        {
          ...validReceipt,
          evidence: {
            ...validReceipt.evidence,
            connectorTarget: CONNECTOR_TARGET,
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects invalid target identities and private content fields", () => {
    expect(
      assertInvalid(
        {
          ...withConnector("failed", "connector_unsupported_config"),
          evidence: {
            ...validReceipt.evidence,
            connectorTarget: "mcp:cursor:user:/Users/private/.cursor/mcp.json",
          },
        },
        schema
      )
    ).toBe(true);
    expect(assertInvalid({ ...validReceipt, query: "secret" }, schema)).toBe(
      true
    );
    expect(
      assertInvalid(
        {
          ...validReceipt,
          evidence: { ...validReceipt.evidence, snippet: "secret passage" },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects RFC 3339 calendar-invalid receipt and stage timestamps", () => {
    for (const generatedAt of [
      "2026-02-29T10:00:00Z",
      "2026-04-31T10:00:00Z",
      "2026-07-22T24:00:00Z",
      "2026-07-22T10:00:00+24:00",
    ]) {
      expect(assertInvalid({ ...validReceipt, generatedAt }, schema)).toBe(
        true
      );
    }
    expect(
      assertInvalid(
        {
          ...validReceipt,
          stages: {
            ...validReceipt.stages,
            lexical: {
              ...validReceipt.stages.lexical,
              completedAt: "2026-02-30T10:00:00Z",
            },
          },
        },
        schema
      )
    ).toBe(true);
  });
});
