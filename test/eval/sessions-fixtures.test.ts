import { describe, expect, test } from "bun:test";

import type { GoldFixture } from "../../evals/helpers/sessions-fixtures";

import {
  buildSessionsManifest,
  checkSessionsManifest,
  flattenGold,
  loadSessionsCases,
  SESSIONS_FIXTURE_MANIFEST,
  SESSIONS_FIXTURE_ROOT,
} from "../../evals/helpers/sessions-fixtures";

describe("sessions eval fixtures", () => {
  test("fixtures match their committed sha256 pins", async () => {
    const committed: unknown = await Bun.file(
      `${SESSIONS_FIXTURE_ROOT}/${SESSIONS_FIXTURE_MANIFEST}`
    ).json();
    const actual = await buildSessionsManifest();
    expect(checkSessionsManifest(committed, actual).files).toEqual(
      actual.files
    );
  });

  test("the pin check fails closed on drift, missing and malformed manifests", async () => {
    const actual = await buildSessionsManifest();
    const [first] = Object.keys(actual.files);
    if (!first) throw new Error("no fixture files");
    expect(() =>
      checkSessionsManifest(
        { ...actual, files: { ...actual.files, [first]: "0".repeat(64) } },
        actual
      )
    ).toThrow(new RegExp(`changed or unpinned: ${first}`));
    expect(() =>
      checkSessionsManifest(
        { ...actual, files: { ...actual.files, "gone.json": "0" } },
        actual
      )
    ).toThrow(/missing: gone\.json/);
    for (const malformed of [null, [], { algorithm: "md5", files: {} }]) {
      expect(() => checkSessionsManifest(malformed, actual)).toThrow(
        /malformed/
      );
    }
  });

  test("every case key resolves to a unique gold turn with no raw secret", async () => {
    const cases = await loadSessionsCases();
    const goldText = await Bun.file(
      `${SESSIONS_FIXTURE_ROOT}/gold/turns.json`
    ).text();
    const gold = flattenGold(JSON.parse(goldText) as GoldFixture);
    const keys = new Set(gold.map((turn) => turn.key));
    expect(keys.size).toBe(gold.length);
    const referenced = [
      ...cases.lookups.map((lookup) => lookup.expect),
      ...cases.questions.flatMap((question) => question.gold),
    ];
    expect(referenced.filter((key) => !keys.has(key))).toEqual([]);
    for (const secret of [
      ...cases.secrets.map((item) => item.value),
      ...cases.secretMarkers,
    ]) {
      expect(goldText).not.toContain(secret);
    }
  });
});
