import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";

import { ConfigSchema, parseFindingsCadenceMs } from "../../src/config/types";
import {
  createPendingFindingsRunState,
  findingsRunStatePath,
  formatFindingsRunStatusLine,
  projectFindingsRunStatus,
  readFindingsRunStatus,
  resolveFindingsSchedule,
  writeFindingsRunState,
} from "../../src/core/findings-run-state";
import { safeRm } from "../helpers/cleanup";

const baseConfig = (findings?: Config["findings"]): Config => ({
  version: "1.0",
  ftsTokenizer: "unicode61",
  collections: [
    {
      name: "notes",
      path: "/tmp/notes",
      pattern: "**/*",
      include: [],
      exclude: [],
    },
    {
      name: "findings",
      path: "/tmp/findings",
      pattern: "**/*",
      include: [],
      exclude: [],
    },
  ],
  contexts: [],
  findings,
});

describe("findings config", () => {
  test.each([
    ["10s", 10_000],
    ["30m", 1_800_000],
    ["6h", 21_600_000],
    ["1d", 86_400_000],
    ["5s", null],
    ["31d", null],
    ["6", null],
    ["h6", null],
    ["", null],
  ])("parseFindingsCadenceMs(%p) -> %p", (raw, expected) => {
    expect(parseFindingsCadenceMs(raw)).toBe(expected);
  });

  test("schema defaults to disabled with a 6h cadence and rejects bad cadences", () => {
    const parsed = ConfigSchema.parse({ version: "1.0", findings: {} });
    expect(parsed.findings).toEqual({ enabled: false, cadence: "6h" });
    const bad = ConfigSchema.safeParse({
      version: "1.0",
      findings: { enabled: true, cadence: "5x", collection: "findings" },
    });
    expect(bad.success).toBe(false);
  });

  test("resolveFindingsSchedule: disabled, enabled-without-collection, unknown collection, enabled", () => {
    expect(resolveFindingsSchedule(baseConfig(undefined))).toEqual({
      ok: true,
      enabled: false,
    });
    expect(
      resolveFindingsSchedule(baseConfig({ enabled: false, cadence: "6h" }))
    ).toEqual({ ok: true, enabled: false });

    const missing = resolveFindingsSchedule(
      baseConfig({ enabled: true, cadence: "6h" })
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok)
      expect(missing.error).toContain("findings.collection is not set");

    const unknown = resolveFindingsSchedule(
      baseConfig({ enabled: true, cadence: "6h", collection: "nope" })
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.error).toContain('"nope" is not a configured collection');

    const enabled = resolveFindingsSchedule(
      baseConfig({ enabled: true, cadence: "30m", collection: "findings" })
    );
    expect(enabled).toMatchObject({
      ok: true,
      enabled: true,
      schedule: { cadence: "30m", cadenceMs: 1_800_000 },
    });
  });
});

describe("findings run state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gno-findings-state-"));
  });
  afterEach(async () => {
    await safeRm(dir);
  });

  const schedule = {
    collection: baseConfig().collections[1]!,
    cadence: "1h",
    cadenceMs: 3_600_000,
  };
  const now = new Date("2026-09-03T10:00:00.000Z");

  test("state path sits next to the index database", () => {
    expect(findingsRunStatePath("/data/index-default.sqlite")).toBe(
      "/data/index-default.findings-run.json"
    );
  });

  test("round-trips through disk and reports absent/corrupt files as null", async () => {
    const path = join(dir, "index-default.findings-run.json");
    expect(await readFindingsRunStatus(path, now)).toBeNull();
    const record = createPendingFindingsRunState(schedule, now);
    await writeFindingsRunState(path, record);
    const status = await readFindingsRunStatus(path, now);
    expect(status).toEqual({ ...record, state: "pending" });
    await Bun.write(path, "{not json");
    expect(await readFindingsRunStatus(path, now)).toBeNull();
  });

  test.each([
    ["a string", "3"],
    ["a negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["null", null],
    ["missing", undefined],
  ])(
    "corrupt counts (%s) read as null instead of a partial status",
    async (_label, open) => {
      const path = join(dir, "index-default.findings-run.json");
      const counts: Record<string, unknown> = {
        findings: 2,
        written: 1,
        reopened: 0,
        resolved: 0,
        deleted: 0,
        open,
      };
      if (open === undefined) delete counts.open;
      const record = {
        ...createPendingFindingsRunState(schedule, now),
        lastOutcome: "success",
        counts,
      };
      await Bun.write(path, JSON.stringify(record));
      expect(await readFindingsRunStatus(path, now)).toBeNull();
    }
  );

  test("counts as a non-object read as null; null counts stay null", async () => {
    const path = join(dir, "index-default.findings-run.json");
    const base = createPendingFindingsRunState(schedule, now);
    await Bun.write(path, JSON.stringify({ ...base, counts: "lots" }));
    expect(await readFindingsRunStatus(path, now)).toBeNull();
    await Bun.write(path, JSON.stringify({ ...base, counts: null }));
    expect((await readFindingsRunStatus(path, now))?.counts).toBeNull();
  });

  test("projects overdue once the due time slipped by a full cadence", () => {
    const record = {
      ...createPendingFindingsRunState(schedule, now),
      lastOutcome: "success" as const,
      lastRunAt: now.toISOString(),
    };
    const dueAt = Date.parse(record.nextDueAt);
    expect(projectFindingsRunStatus(record, new Date(dueAt + 1)).state).toBe(
      "success"
    );
    expect(
      projectFindingsRunStatus(record, new Date(dueAt + schedule.cadenceMs + 1))
        .state
    ).toBe("overdue");
  });

  test("status line carries state, counts, due time and error", () => {
    const status = projectFindingsRunStatus(
      {
        ...createPendingFindingsRunState(schedule, now),
        lastOutcome: "skipped_lease",
        lastRunAt: now.toISOString(),
        counts: {
          findings: 2,
          written: 1,
          reopened: 0,
          resolved: 0,
          deleted: 0,
          open: 2,
        },
        error: "lease held by gno index (pid 4)",
      },
      now
    );
    const line = formatFindingsRunStatusLine(status);
    expect(line).toStartWith("skipped_lease (");
    expect(line).toContain("2 open, 1 new, 0 resolved");
    expect(line).toContain("next due ");
    expect(line).toContain("error: lease held by gno index (pid 4)");
  });
});
