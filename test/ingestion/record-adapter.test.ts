import { describe, expect, test } from "bun:test";

import type {
  Converter,
  RecordAdapter,
  RecordAdapterEvent,
  RecordAdapterInput,
} from "../../src/converters/types";

import { ConverterRegistry } from "../../src/converters/registry";
import { createEgressLineage } from "../../src/core/egress-provenance";
import {
  recordKeyFor,
  runRecordAdapter,
} from "../../src/ingestion/record-adapter";
import { safeFailure } from "../../src/ingestion/record-adapter-canonical";

const limits = {
  maxSourceBytes: 1_024,
  maxRecordChars: 1_000,
  maxMetadataChars: 1_000,
  maxTotalChars: 5_000,
  maxRecords: 10,
  maxFailures: 10,
};

const input = (
  overrides: Partial<RecordAdapterInput> = {}
): RecordAdapterInput => ({
  sourcePath: "/private/source/export.jsonl",
  relativePath: "export.jsonl",
  collection: "test",
  mime: "application/x-ndjson",
  ext: ".jsonl",
  open: async function* () {
    yield new TextEncoder().encode("source");
  },
  limits,
  ...overrides,
});

const adapter = (
  events: RecordAdapterEvent[],
  overrides: Partial<RecordAdapter> = {}
): RecordAdapter => ({
  id: "adapter/test-records",
  version: "1.0.0",
  canHandle: (_mime, ext) => ext === ".jsonl",
  records: async function* () {
    for (const event of events) yield event;
  },
  ...overrides,
});

const record = (
  stableId: string,
  markdown: string,
  sourceLocator = `line:${stableId}`
): RecordAdapterEvent => ({
  type: "record",
  record: { stableId, sourceLocator, markdown },
});

const complete: RecordAdapterEvent = {
  type: "snapshot",
  state: "complete",
};

describe("streaming record adapter contract", () => {
  test("retains source policy at the adapter boundary", async () => {
    const egressLineage = createEgressLineage([
      { collection: "imports", policy: "lan", source: "explicit" },
    ]);
    const result = await runRecordAdapter(adapter([complete]), input(), {
      egressLineage,
    });

    expect(result.egressLineage).toEqual(egressLineage);
  });

  test("keeps byte converters and record adapters in separate registry lanes", async () => {
    const legacy: Converter = {
      id: "legacy",
      version: "1",
      canHandle: () => true,
      convert: async () => ({
        ok: true,
        value: {
          markdown: "legacy bytes",
          meta: {
            converterId: "legacy",
            converterVersion: "1",
            sourceMime: "text/plain",
          },
        },
      }),
    };
    const streaming = adapter([complete]);
    const registry = new ConverterRegistry();
    registry.register(legacy);
    registry.registerRecordAdapter(streaming);

    expect(registry.listConverters()).toEqual(["legacy"]);
    expect(registry.listRecordAdapters()).toEqual(["adapter/test-records"]);
    expect(registry.select("text/plain", ".jsonl")).toBe(legacy);
    expect(registry.selectRecordAdapter("APPLICATION/X-NDJSON", ".JSONL")).toBe(
      streaming
    );
  });

  test("canonicalizes independent records and computes stable identities", async () => {
    const first = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: " cafe\u0301 ",
            sourceLocator: "line:1",
            markdown: "Hello  \r\n",
            metadata: {
              dateFields: { updated: " 2026-07-22 ", created: "2026-01-01" },
            },
          },
        },
        complete,
      ]),
      input()
    );
    const second = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: "café",
            sourceLocator: "line:1",
            markdown: "Hello\n",
            metadata: {
              dateFields: { created: "2026-01-01", updated: "2026-07-22" },
            },
          },
        },
        complete,
      ]),
      input()
    );

    expect(first.authoritative).toBe(true);
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.markdown).toBe("Hello\n");
    expect(first.records[0]?.recordKey).toBe(second.records[0]?.recordKey);
    expect(first.records[0]?.sourceHash).toBe(second.records[0]?.sourceHash);
    expect(first.records[0]?.mirrorHash).toBe(second.records[0]?.mirrorHash);
  });

  test("keeps record identity stable across adapter version changes", () => {
    expect(recordKeyFor("adapter/test", "item-1")).toBe(
      recordKeyFor("adapter/test", "item-1")
    );
    expect(recordKeyFor("adapter/test", "item-1")).not.toBe(
      recordKeyFor("adapter/other", "item-1")
    );
  });

  test("bounds and canonicalizes custom adapter identity before execution", async () => {
    let started = false;
    const custom = adapter([], {
      id: " adapter/custom ",
      version: " 1.2.3 ",
      records: async function* () {
        started = true;
        yield complete;
      },
    });
    const result = await runRecordAdapter(custom, input());

    expect(result.adapterId).toBe("adapter/custom");
    expect(result.adapterVersion).toBe("1.2.3");
    expect(started).toBe(true);

    for (const invalid of [
      adapter([], { id: "x".repeat(129) }),
      adapter([], { version: "x".repeat(65) }),
      adapter([], { id: "adapter/\u001bunsafe" }),
    ]) {
      started = false;
      const guarded = {
        ...invalid,
        records: async function* () {
          started = true;
          yield complete;
        },
      };
      let message = "";
      try {
        await runRecordAdapter(guarded, input());
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("invalid record adapter");
      expect(started).toBe(false);
    }
  });

  test("isolates an oversized record while retaining valid siblings", async () => {
    const result = await runRecordAdapter(
      adapter([
        record("one", "valid"),
        record("two", "x".repeat(11)),
        complete,
      ]),
      input({ limits: { ...limits, maxRecordChars: 10 } })
    );

    expect(result.records.map((item) => item.stableId)).toEqual(["one"]);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "RECORD_TOO_LARGE"
    );
    expect(result.authoritative).toBe(false);
  });

  test("invalidates every record sharing a duplicate stable ID", async () => {
    const result = await runRecordAdapter(
      adapter([
        record("duplicate", "first"),
        record("duplicate", "second"),
        complete,
      ]),
      input()
    );

    expect(result.records).toEqual([]);
    expect(result.failedRecordKeys).toEqual([
      recordKeyFor("adapter/test-records", "duplicate"),
    ]);
    expect(
      result.failures.some((failure) => failure.code === "DUPLICATE_ID")
    ).toBe(true);
    expect(result.authoritative).toBe(false);
  });

  test("stops and closes the adapter iterator when a global cap is reached", async () => {
    let closed = false;
    const streaming = adapter([], {
      records: async function* () {
        try {
          yield record("one", "one");
          yield record("two", "two");
          yield complete;
        } finally {
          closed = true;
        }
      },
    });

    const result = await runRecordAdapter(
      streaming,
      input({ limits: { ...limits, maxRecords: 1 } })
    );

    expect(closed).toBe(true);
    expect(result.stoppedByCap).toBe(true);
    expect(result.records.map((item) => item.stableId)).toEqual(["one"]);
    expect(result.authoritative).toBe(false);
  });

  test("enforces the source-byte cap and closes the source iterator", async () => {
    let sourceClosed = false;
    const readsSource = adapter([], {
      records: async function* (adapterInput) {
        for await (const _chunk of adapterInput.open()) {
          // Reading the source is the behavior under test.
        }
        yield complete;
      },
    });
    const result = await runRecordAdapter(
      readsSource,
      input({
        open: async function* () {
          try {
            yield new Uint8Array(6);
          } finally {
            sourceClosed = true;
          }
        },
        limits: { ...limits, maxSourceBytes: 5 },
      })
    );

    expect(sourceClosed).toBe(true);
    expect(
      result.failures.some((failure) => failure.code === "SOURCE_TOO_LARGE")
    ).toBe(true);
    expect(result.sourceBytesRead).toBe(6);
    expect(result.authoritative).toBe(false);
  });

  test("cannot swallow the source cap into an authoritative snapshot", async () => {
    const swallowing = adapter([], {
      records: async function* (adapterInput) {
        try {
          for await (const _chunk of adapterInput.open()) {
            // Adapter deliberately swallows the bounded opener error.
          }
        } catch {
          // The central runner must still remember the cap violation.
        }
        yield complete;
      },
    });
    const result = await runRecordAdapter(
      swallowing,
      input({
        open: async function* () {
          yield new Uint8Array(2);
        },
        limits: { ...limits, maxSourceBytes: 1 },
      })
    );

    expect(result.authoritative).toBe(false);
    expect(result.stoppedByCap).toBe(true);
    expect(
      result.failures.some((failure) => failure.code === "SOURCE_TOO_LARGE")
    ).toBe(true);
  });

  test("cannot swallow a source read error into an authoritative snapshot", async () => {
    const swallowing = adapter([], {
      records: async function* (adapterInput) {
        try {
          for await (const _chunk of adapterInput.open()) {
            // Adapter deliberately swallows the source error.
          }
        } catch {
          // The central runner must still remember the failed read.
        }
        yield complete;
      },
    });
    const result = await runRecordAdapter(
      swallowing,
      input({
        open: async function* () {
          yield* [] as Uint8Array[];
          throw new Error("private source read details");
        },
      })
    );

    expect(result.authoritative).toBe(false);
    expect(
      result.failures.some((failure) => failure.code === "ADAPTER_FAILURE")
    ).toBe(true);
    expect(JSON.stringify(result.failures)).not.toContain(
      "private source read details"
    );
  });

  test("cannot swallow a synchronous source-open error", async () => {
    const swallowing = adapter([], {
      records: async function* (adapterInput) {
        try {
          adapterInput.open()[Symbol.asyncIterator]();
        } catch {
          // The central runner must still remember the failed open.
        }
        yield complete;
      },
    });
    const result = await runRecordAdapter(
      swallowing,
      input({
        open: () => {
          throw new Error("private source open details");
        },
      })
    );

    expect(result.authoritative).toBe(false);
    expect(
      result.failures.some((failure) => failure.code === "ADAPTER_FAILURE")
    ).toBe(true);
    expect(JSON.stringify(result.failures)).not.toContain(
      "private source open details"
    );
  });

  test("bounds failures from continuation branches", async () => {
    const result = await runRecordAdapter(
      adapter([
        record("one", "xx"),
        record("two", "xx"),
        record("three", "xx"),
        record("four", "xx"),
        complete,
      ]),
      input({
        limits: { ...limits, maxRecordChars: 1, maxFailures: 2 },
      })
    );

    expect(result.stoppedByCap).toBe(true);
    expect(result.failures).toHaveLength(2);
    expect(
      result.failures.filter((failure) => failure.code === "RECORD_TOO_LARGE")
    ).toHaveLength(1);
    expect(
      result.failures.some((failure) => failure.code === "FAILURE_LIMIT")
    ).toBe(true);
  });

  test("invalidates duplicates before applying the record-count cap", async () => {
    const result = await runRecordAdapter(
      adapter([record("same", "first"), record("same", "second"), complete]),
      input({ limits: { ...limits, maxRecords: 1 } })
    );

    expect(result.records).toEqual([]);
    expect(
      result.failures.some((failure) => failure.code === "DUPLICATE_ID")
    ).toBe(true);
    expect(
      result.failures.some((failure) => failure.code === "RECORD_LIMIT")
    ).toBe(false);
  });

  test("does not retain adapter-provided private failure messages", async () => {
    const result = await runRecordAdapter(
      adapter([
        {
          type: "failure",
          failure: {
            code: "MALFORMED_RECORD",
            message: "token=never-log user@example.com secret source content",
            retryable: false,
            stableId: "/private/secret-id",
            sourceLocator: "../private/locator",
          },
        },
        complete,
      ]),
      input()
    );
    const rendered = JSON.stringify(result.failures);

    expect(rendered).not.toContain("never-log");
    expect(rendered).not.toContain("user@example.com");
    expect(rendered).not.toContain("/private/secret-id");
    expect(rendered).not.toContain("../private/locator");
  });

  test("rejects missing, duplicate, and non-terminal snapshots", async () => {
    const missing = await runRecordAdapter(
      adapter([record("one", "one")]),
      input()
    );
    const duplicate = await runRecordAdapter(
      adapter([complete, complete]),
      input()
    );
    const afterTerminal = await runRecordAdapter(
      adapter([complete, record("late", "late")]),
      input()
    );

    expect(missing.authoritative).toBe(false);
    expect(duplicate.authoritative).toBe(false);
    expect(afterTerminal.records).toEqual([]);
    for (const result of [missing, duplicate, afterTerminal]) {
      expect(
        result.failures.some((failure) => failure.code === "INVALID_SNAPSHOT")
      ).toBe(true);
    }
  });

  test("redacts paths and thrown private details from failures", async () => {
    const result = await runRecordAdapter(
      adapter([], {
        records: async function* () {
          yield* [] as RecordAdapterEvent[];
          throw new Error(
            "secret payload at /private/source/export.jsonl token=never-log"
          );
        },
      }),
      input()
    );
    const rendered = JSON.stringify(result.failures);

    expect(rendered).not.toContain("/private/source/export.jsonl");
    expect(rendered).not.toContain("never-log");
    expect(result.failures[0]?.code).toBe("ADAPTER_FAILURE");
  });

  test("maps synchronous adapter construction failures into receipts", async () => {
    const synchronousFailure: RecordAdapter = {
      id: "adapter/synchronous-failure",
      version: "1.0.0",
      canHandle: () => true,
      records: () => {
        throw new Error("private synchronous failure");
      },
    };
    const result = await runRecordAdapter(synchronousFailure, input());

    expect(result.authoritative).toBe(false);
    expect(
      result.failures.some((failure) => failure.code === "ADAPTER_FAILURE")
    ).toBe(true);
    expect(JSON.stringify(result.failures)).not.toContain(
      "private synchronous failure"
    );
  });

  test("rejects absolute identifiers and path-traversing locators", async () => {
    const result = await runRecordAdapter(
      adapter([
        record("/private/secret", "bad", "line:1"),
        record("safe", "bad", "../secret"),
        complete,
      ]),
      input()
    );

    expect(result.records).toEqual([]);
    expect(result.failures.map((failure) => failure.code).sort()).toEqual([
      "INVALID_LOCATOR",
      "MISSING_ID",
    ]);
  });

  test("rejects an explicitly empty source hash", async () => {
    const result = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: "one",
            sourceLocator: "line:1",
            sourceHash: "",
            markdown: "content",
          },
        },
        complete,
      ]),
      input()
    );

    expect(result.records).toEqual([]);
    expect(
      result.failures.some((failure) => failure.code === "INVALID_SOURCE_HASH")
    ).toBe(true);
  });

  test("rejects metadata that cannot satisfy every output contract", async () => {
    const result = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: "oversized-metadata",
            sourceLocator: "line:1",
            markdown: "bounded body",
            metadata: {
              participants: Array.from(
                { length: 257 },
                (_, index) => `person-${index}`
              ),
            },
          },
        },
        complete,
      ]),
      input({ limits: { ...limits, maxMetadataChars: 100_000 } })
    );

    expect(result.records).toEqual([]);
    expect(result.authoritative).toBe(false);
    expect(result.failures.map(({ code }) => code)).toContain(
      "RECORD_TOO_LARGE"
    );
  });

  test("rejects custom adapter enum, numeric, and digest values outside the output schemas", async () => {
    const result = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: "bad-disposition",
            sourceLocator: "line:1",
            markdown: "bounded body",
            metadata: {
              attachments: [
                {
                  name: "attachment.txt",
                  disposition: "download" as never,
                },
              ],
            },
          },
        },
        {
          type: "record",
          record: {
            stableId: "bad-anchor-kind",
            sourceLocator: "line:2",
            markdown: "bounded body",
            anchors: [{ kind: "offset" as never, value: "2" }],
          },
        },
        {
          type: "record",
          record: {
            stableId: "unsafe-byte-count",
            sourceLocator: "line:3",
            markdown: "bounded body",
            metadata: {
              attachments: [
                {
                  name: "attachment.bin",
                  bytes: Number.MAX_SAFE_INTEGER + 1,
                },
              ],
            },
          },
        },
        {
          type: "record",
          record: {
            stableId: "invalid-attachment-digest",
            sourceLocator: "line:4",
            markdown: "bounded body",
            metadata: {
              attachments: [
                {
                  name: "attachment.bin",
                  sha256: "not-a-sha256",
                },
              ],
            },
          },
        },
        complete,
      ]),
      input({ limits: { ...limits, maxMetadataChars: 100_000 } })
    );

    expect(result.records).toEqual([]);
    expect(
      result.failures.filter(({ code }) => code === "RECORD_TOO_LARGE")
    ).toHaveLength(4);
  });

  test("removes every terminal control from accepted metadata", async () => {
    const result = await runRecordAdapter(
      adapter([
        {
          type: "record",
          record: {
            stableId: "controlled-metadata",
            sourceLocator: "line:1",
            markdown: "bounded body",
            title: "A\u0001B\u0002C",
            metadata: {
              author: "D\u0003E\u0004F",
              dateFields: { created: "G\u0005H\u0006I" },
            },
          },
        },
        complete,
      ]),
      input()
    );

    expect(result.records[0]?.title).toBe("ABC");
    expect(result.records[0]?.metadata?.author).toBe("DEF");
    expect(result.records[0]?.metadata?.dateFields).toEqual({ created: "GHI" });
  });

  test("removes every terminal control from safe failures", () => {
    const failure = safeFailure(
      input(),
      "ADAPTER_FAILURE",
      "first\u001bsecond\u0007third\u007flast",
      false
    );

    expect(failure.message).toBe("first second third last");
    let containsTerminalControl = false;
    for (const character of failure.message) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || codePoint === 127) {
        containsTerminalControl = true;
        break;
      }
    }
    expect(containsTerminalControl).toBe(false);
  });

  test("bounds a stalled adapter with the central deadline", async () => {
    let observedAbort = false;
    const stalled = adapter([], {
      records: async function* (adapterInput) {
        await new Promise<void>((resolve) => {
          adapterInput.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true }
          );
        });
        yield complete;
      },
    });
    const started = performance.now();
    const result = await runRecordAdapter(
      stalled,
      input({ limits: { ...limits, timeoutMs: 20 } })
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(result.authoritative).toBe(false);
    expect(result.stoppedByCap).toBe(true);
    expect(result.failures.map(({ code }) => code)).toContain("TIMEOUT");
    expect(observedAbort).toBe(true);
  });
});

test("custom metadata validates without dropping ordinary record evidence", async () => {
  const good = await runRecordAdapter(
    adapter([
      {
        type: "record",
        record: {
          stableId: "good",
          sourceLocator: "line:1",
          markdown: "ordinary evidence",
          metadata: {
            custom: { approved: false, confidence: 0, teams: ["search"] },
          },
        },
      },
      complete,
    ]),
    input()
  );
  expect(good.records).toHaveLength(1);
  expect(good.records[0]?.metadata?.custom).toEqual({
    approved: false,
    confidence: 0,
    teams: ["search"],
  });
  const bad = await runRecordAdapter(
    adapter([
      {
        type: "record",
        record: {
          stableId: "bad",
          sourceLocator: "line:1",
          markdown: "ordinary evidence",
          metadata: { custom: JSON.parse('{"approved":null}') },
        },
      },
      complete,
    ]),
    input()
  );
  expect(bad.records).toHaveLength(1);
  expect(bad.records[0]?.markdown).toContain("ordinary evidence");
  expect(bad.records[0]?.metadata?.custom).toBeUndefined();
  expect(bad.records[0]?.metadata?.customError).toContain(
    "invalid typed metadata"
  );
});
