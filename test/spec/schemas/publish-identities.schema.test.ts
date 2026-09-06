import { beforeAll, expect, test } from "bun:test";

import {
  buildEncryptedPublishArtifact,
  buildPublishArtifact,
} from "../../../src/publish/artifact";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const id = "0580747a-18a8-4ce5-bcd8-2a13041cdfe8";
let schema: object;
beforeAll(async () => {
  schema = await loadSchema("publish-artifact");
});
const plain = () =>
  buildPublishArtifact({
    notes: [
      { id, markdown: "Hello", slug: "hello", summary: "", title: "Hello" },
    ],
    routeSlug: "hello",
    sourceType: "note",
    summary: "",
    title: "Hello",
    visibility: "secret-link",
  });
const encrypted = () =>
  buildEncryptedPublishArtifact({
    noteIds: [id],
    encryptedPayload: {
      ciphertext: "YQ==",
      iv: "YQ==",
      salt: "YQ==",
      iterations: 1,
    },
    routeSlug: "hello",
    secretToken: "opaque",
    sourceType: "note",
  });

test("stable note IDs and legacy artifacts both validate", () => {
  const v1 = plain();
  const v2 = encrypted();
  expect(v1.spaces[0]?.notes[0]?.id).toBe(id);
  expect(v2.spaces[0]?.noteIds).toEqual([id]);
  expect(assertValid(v1, schema)).toBe(true);
  expect(assertValid(v2, schema)).toBe(true);
  delete v1.spaces[0]!.notes[0]!.id;
  delete v2.spaces[0]!.noteIds;
  expect(assertValid(v1, schema)).toBe(true);
  expect(assertValid(v2, schema)).toBe(true);
});

test("schema rejects non-UUID IDs and empty, duplicate, oversized rosters", () => {
  const v1 = plain();
  v1.spaces[0]!.notes[0]!.id = "local/path.md";
  expect(assertInvalid(v1, schema)).toBe(true);
  for (const roster of [
    [],
    [id, id],
    ["local:slug"],
    Array.from({ length: 5001 }, () => crypto.randomUUID()),
  ]) {
    const v2 = encrypted();
    v2.spaces[0]!.noteIds = roster;
    expect(assertInvalid(v2, schema)).toBe(true);
  }
});
