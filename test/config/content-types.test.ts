import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdir has no Bun equivalent for directory creation.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config, ContentTypeConfig } from "../../src/config";

import {
  fingerprintContentTypeRules,
  normalizeConfigContentTypes,
  normalizeContentTypes,
} from "../../src/config";
import { loadConfigFromPath } from "../../src/config/loader";
import { safeRm } from "../helpers/cleanup";

describe("normalizeContentTypes", () => {
  test("returns no rules or warnings for empty contentTypes", () => {
    const result = normalizeContentTypes([]);

    expect(result.rules).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warns and drops entries with unknown preset refs", () => {
    const result = normalizeContentTypes([
      {
        id: "person",
        prefixes: ["people/"],
        preset: "missing-preset",
      },
      {
        id: "meeting",
        prefixes: ["meetings/"],
        preset: "meeting",
      },
    ]);

    expect(result.rules.map((rule) => rule.id)).toEqual(["meeting"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("UNKNOWN_CONTENT_TYPE_PRESET");
    expect(result.warnings[0]?.path).toBe("contentTypes[0].preset");
  });

  test("dedupes exact duplicate prefixes and keeps overlapping prefixes", () => {
    const result = normalizeContentTypes([
      {
        id: "person",
        prefixes: ["people/", "people/team/", "people/"],
        preset: "person",
      },
      {
        id: "company",
        prefixes: ["companies/", "people/team/"],
        preset: "company-project",
      },
    ]);

    expect(result.rules).toHaveLength(2);
    expect(result.rules[0]?.id).toBe("person");
    expect(result.rules[0]?.prefixes).toEqual(["people/team/", "people/"]);
    expect(result.rules[1]?.prefixes).toEqual(["companies/"]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "DUPLICATE_CONTENT_TYPE_PREFIX",
      "DUPLICATE_CONTENT_TYPE_PREFIX",
    ]);
  });

  test("sorts rules for longest-prefix-wins matching", () => {
    const result = normalizeContentTypes([
      {
        id: "meeting",
        prefixes: ["meetings/"],
        preset: "meeting",
      },
      {
        id: "person",
        prefixes: ["people/team/"],
        preset: "person",
      },
    ]);

    expect(result.rules.map((rule) => rule.id)).toEqual(["person", "meeting"]);
  });

  test("preserves reserved no-op fields", () => {
    const result = normalizeContentTypes([
      {
        id: "person",
        prefixes: ["people/"],
        preset: "person",
        graphHints: ["mentions", "works_at"],
        searchBoost: 1.15,
        temporal: true,
      },
    ]);

    expect(result.rules[0]?.graphHints).toEqual(["mentions", "works_at"]);
    expect(result.rules[0]?.searchBoost).toBe(1.15);
    expect(result.rules[0]?.temporal).toBe(true);
  });

  test("fingerprint ignores reserved no-op fields", () => {
    const base = normalizeContentTypes([
      { id: "person", prefixes: ["people/"], preset: "person" },
    ]);
    const withNoOps = normalizeContentTypes([
      {
        id: "person",
        prefixes: ["people/"],
        preset: "person",
        graphHints: ["mentions"],
        searchBoost: 1.15,
        temporal: true,
      },
    ]);

    expect(fingerprintContentTypeRules(withNoOps.rules)).toBe(
      fingerprintContentTypeRules(base.rules)
    );
  });

  test("fingerprint changes when preset changes", () => {
    const personPreset = normalizeContentTypes([
      { id: "person", prefixes: ["people/"], preset: "person" },
    ]);
    const meetingPreset = normalizeContentTypes([
      { id: "person", prefixes: ["people/"], preset: "meeting" },
    ]);

    expect(fingerprintContentTypeRules(meetingPreset.rules)).not.toBe(
      fingerprintContentTypeRules(personPreset.rules)
    );
  });
});

describe("normalizeConfigContentTypes", () => {
  test("normalizes inline config before runtime use", () => {
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "snowball english",
      collections: [],
      contexts: [],
      contentTypes: [
        {
          id: "person",
          prefixes: ["people/", "people/"],
          preset: "person",
        },
      ],
    };

    const result = normalizeConfigContentTypes(config);

    expect(result.config.contentTypes?.[0]?.prefixes).toEqual(["people/"]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("loadConfigFromPath contentTypes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `gno-content-types-${Date.now()}`);
  });

  afterEach(async () => {
    await safeRm(tempDir);
  });

  async function writeConfig(
    contentTypes?: ContentTypeConfig[]
  ): Promise<string> {
    await mkdir(tempDir, { recursive: true });
    const filePath = join(tempDir, "index.yml");
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "snowball english",
      collections: [],
      contexts: [],
      contentTypes: contentTypes ?? [],
    };
    await Bun.write(filePath, Bun.YAML.stringify(config));
    return filePath;
  }

  test("loads absent contentTypes as legacy empty rules with no warnings", async () => {
    const filePath = join(tempDir, "index.yml");
    await mkdir(tempDir, { recursive: true });
    await Bun.write(
      filePath,
      Bun.YAML.stringify({
        version: "1.0",
        ftsTokenizer: "snowball english",
        collections: [],
        contexts: [],
      })
    );

    const result = await loadConfigFromPath(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.contentTypes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warns and drops invalid preset refs without load failure", async () => {
    const filePath = await writeConfig([
      {
        id: "person",
        prefixes: ["people/"],
        preset: "not-a-preset",
      },
    ]);

    const result = await loadConfigFromPath(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.contentTypes).toEqual([]);
    expect(result.warnings[0]?.code).toBe("UNKNOWN_CONTENT_TYPE_PRESET");
  });
});
