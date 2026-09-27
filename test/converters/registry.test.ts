/**
 * Tests for converter registry.
 */

import { describe, expect, test } from "bun:test";

import type { Converter, ConvertInput } from "../../src/converters/types";

import {
  ConverterRegistry,
  createDefaultRegistry,
} from "../../src/converters/registry";
import { DEFAULT_LIMITS } from "../../src/converters/types";

function makeInput(overrides: Partial<ConvertInput>): ConvertInput {
  return {
    sourcePath: "/test/file.md",
    relativePath: "file.md",
    collection: "test",
    bytes: new Uint8Array(0),
    mime: "text/markdown",
    ext: ".md",
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

const mockConverter: Converter = {
  id: "test/mock",
  version: "1.0.0",
  canHandle: (mime, ext) => mime === "test/mock" || ext === ".mock",
  convert: async () => ({
    ok: true,
    value: {
      markdown: "# Mock Output",
      meta: {
        converterId: "test/mock",
        converterVersion: "1.0.0",
        sourceMime: "test/mock",
      },
    },
  }),
};

describe("ConverterRegistry", () => {
  test("register and select converter", () => {
    const registry = new ConverterRegistry();
    registry.register(mockConverter);

    const selected = registry.select("test/mock", ".mock");
    expect(selected).toBe(mockConverter);
  });

  test("select returns undefined for unknown type", () => {
    const registry = new ConverterRegistry();
    registry.register(mockConverter);

    const selected = registry.select("unknown/type", ".unknown");
    expect(selected).toBeUndefined();
  });

  test("first matching converter wins", () => {
    const registry = new ConverterRegistry();
    const firstConverter: Converter = {
      ...mockConverter,
      id: "first",
      canHandle: () => true,
    };
    const secondConverter: Converter = {
      ...mockConverter,
      id: "second",
      canHandle: () => true,
    };

    registry.register(firstConverter);
    registry.register(secondConverter);

    const selected = registry.select("any", ".any");
    expect(selected?.id).toBe("first");
  });

  test("listConverters returns all registered IDs", () => {
    const registry = new ConverterRegistry();
    registry.register(mockConverter);
    registry.register({ ...mockConverter, id: "test/other" });

    const ids = registry.listConverters();
    expect(ids).toEqual(["test/mock", "test/other"]);
  });

  test("convert invokes matching converter", async () => {
    const registry = new ConverterRegistry();
    registry.register(mockConverter);

    const input = makeInput({ mime: "test/mock", ext: ".mock" });
    const result = await registry.convert(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.markdown).toBe("# Mock Output");
    }
  });

  test("convert returns UNSUPPORTED for unknown type", async () => {
    const registry = new ConverterRegistry();

    const input = makeInput({ mime: "unknown/type", ext: ".unknown" });
    const result = await registry.convert(input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNSUPPORTED");
    }
  });

  test("streaming adapters do not change legacy converter selection", () => {
    const registry = new ConverterRegistry();
    registry.register(mockConverter);
    registry.registerRecordAdapter({
      id: "test/records",
      version: "1.0.0",
      canHandle: () => true,
      records: async function* () {
        yield { type: "snapshot", state: "complete" };
      },
    });

    expect(registry.select("test/mock", ".mock")).toBe(mockConverter);
    expect(registry.listConverters()).toEqual(["test/mock"]);
    expect(registry.listRecordAdapters()).toEqual(["test/records"]);
  });
});

describe("createDefaultRegistry", () => {
  test("includes all MVP converters", async () => {
    const registry = await createDefaultRegistry();
    const ids = registry.listConverters();

    expect(ids).toContain("native/markdown");
    expect(ids).toContain("native/plaintext");
    expect(ids).toContain("adapter/markitdown-ts");
    expect(ids).toContain("adapter/officeparser");
  });

  test("selects markdown converter for .md", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select("text/markdown", ".md");
    expect(converter?.id).toBe("native/markdown");
  });

  test("selects plaintext converter for .txt", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select("text/plain", ".txt");
    expect(converter?.id).toBe("native/plaintext");
  });

  test("selects markitdown for .pdf", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select("application/pdf", ".pdf");
    expect(converter?.id).toBe("adapter/markitdown-ts");
  });

  test("selects markitdown for .docx", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".docx"
    );
    expect(converter?.id).toBe("adapter/markitdown-ts");
  });

  test("selects the direct xlsx adapter for .xlsx", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsx"
    );
    expect(converter?.id).toBe("adapter/xlsx");
  });

  test("selects officeparser for .pptx", async () => {
    const registry = await createDefaultRegistry();
    const converter = registry.select(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".pptx"
    );
    expect(converter?.id).toBe("adapter/officeparser");
  });
});
