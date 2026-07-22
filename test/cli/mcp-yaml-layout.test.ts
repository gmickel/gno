import { describe, expect, test } from "bun:test";

import {
  getYamlServerEntry,
  removeYamlServerEntry,
  setYamlServerEntry,
} from "../../src/cli/commands/mcp/yaml-config-editor";

const CONFIG_PATH = "/tmp/librechat.yaml";
const ENTRY = {
  command: "/opt/bun",
  args: ["run", "/opt/gno/src/index.ts", "mcp"],
};

const setEntry = (content: string): string =>
  setYamlServerEntry(content, CONFIG_PATH, "mcpServers", ENTRY);

describe("LibreChat YAML layout scanner", () => {
  test.each([
    `mcpServers: {}\n"mcp\\u0053ervers": {}\n`,
    `mcpServers: { gno: {}, "g\\u006eo": {} }\n`,
    `mcpServers:\n  gno: {}\n  'gno': {}\n`,
  ])("rejects duplicate decoded target keys without mutation", (content) => {
    expect(() => setEntry(content)).toThrow("duplicate");
    expect(content).toBe(content);
  });

  test.each([
    `base: &base { gno: {} }\nmcpServers: *base\n`,
    `base: &base { gno: {} }\nmcpServers:\n  <<: *base\n`,
    `mcpServers: &shared {}\n`,
    `mcpServers: !!map {}\n`,
    `? mcpServers\n: {}\n`,
    `---\nmcpServers: {}\n---\nmcpServers: {}\n`,
  ])("fails closed for indirect or ambiguous target maps", (content) => {
    expect(() => setEntry(content)).toThrow();
  });

  test("ignores target-looking text inside block scalars", () => {
    const original = `notes: |\n  mcpServers:\n    gno: fake\nmcpServers:\n  other: { command: /bin/other }\n`;
    const installed = setEntry(original);
    expect(
      getYamlServerEntry(installed, CONFIG_PATH, "mcpServers")
    ).toMatchObject({
      exists: true,
      entry: ENTRY,
    });
    expect(installed).toContain("  mcpServers:\n    gno: fake\n");
    expect(
      removeYamlServerEntry(installed, CONFIG_PATH, "mcpServers").content
    ).toBe(original);
  });

  test("replaces a target block-scalar value without consuming siblings", () => {
    const original = `mcpServers:\n  gno: |\n    legacy command\n  other: { command: /bin/other }\n`;
    const installed = setEntry(original);
    expect(installed).not.toContain("legacy command");
    expect(installed).toContain("  other: { command: /bin/other }\n");
  });

  test("preserves standalone comments following the target entry", () => {
    const original = `mcpServers:\n  gno: { command: /bin/old }\n  # keep operator note\n  other: { command: /bin/other }\n`;
    const installed = setEntry(original);
    expect(installed).toContain("  # keep operator note\n");
    const removed = removeYamlServerEntry(
      installed,
      CONFIG_PATH,
      "mcpServers"
    ).content;
    expect(removed).toContain("  # keep operator note\n");
    expect(removed).toContain("  other: { command: /bin/other }\n");
  });

  test("handles an inline comment before a nested target value", () => {
    const original = `mcpServers:\n  gno: # operator note\n    command: /bin/old\n  other: { command: /bin/other }\n`;
    const installed = setEntry(original);
    expect(installed).not.toContain("command: /bin/old");
    expect(installed).toContain("  other: { command: /bin/other }\n");
  });

  test("rejects root merges that could shadow inherited MCP servers", () => {
    const original = `base: &base\n  mcpServers:\n    other: { command: /bin/other }\n<<: *base\n`;
    expect(() => setEntry(original)).toThrow("merged YAML root");
  });

  test("round-trips pathological flow content byte-for-byte", () => {
    const original =
      `mcpServers: { other: { value: "a,b}:#x", nested: [1, { text: 'y,z:#{}' }] } } # keep\r\n` +
      `tail: { enabled: true,  mode: strict }`;
    const installed = setEntry(original);
    expect(
      removeYamlServerEntry(installed, CONFIG_PATH, "mcpServers").content
    ).toBe(original);
  });

  test.each(["# comment only", "# comment only\r\n# second"])(
    "round-trips comment-only files without inventing a final newline",
    (original) => {
      const installed = setEntry(original);
      expect(
        removeYamlServerEntry(installed, CONFIG_PATH, "mcpServers").content
      ).toBe(original);
    }
  );

  test.each(["\n", "\r\n"])(
    "round-trips an existing block map with no final newline (%s)",
    (newline) => {
      const original = `mcpServers:${newline}  other: 1`;
      const installed = setEntry(original);
      expect(
        removeYamlServerEntry(installed, CONFIG_PATH, "mcpServers").content
      ).toBe(original);
    }
  );

  test.each([" ", "  "])(
    "round-trips whitespace-only flow maps (%s)",
    (whitespace) => {
      const original = `mcpServers: {${whitespace}}`;
      const installed = setEntry(original);
      expect(
        removeYamlServerEntry(installed, CONFIG_PATH, "mcpServers").content
      ).toBe(original);
    }
  );
});
