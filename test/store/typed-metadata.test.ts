import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import type {
  MetadataPredicate,
  TypedMetadata,
} from "../../src/core/typed-metadata";

import {
  matchesMetadataPredicate,
  metadataPredicateSchema,
  normalizeMetadataPredicate,
  typedMetadataSchema,
} from "../../src/core/typed-metadata";
import { compileMetadataPredicate } from "../../src/store/sqlite/metadata-predicate";

const maps: TypedMetadata[] = [
  {},
  { x: false },
  { x: true },
  { x: 0 },
  { x: 1 },
  { x: "1" },
  { x: "" },
  { x: [] },
  { x: [0, 1] },
  { x: ["A", "B"] },
  { "a.b": "quoted", "quote' OR 1=1": true },
];
const predicates: MetadataPredicate[] = [
  ...([false, true, 0, 1, "1", ""] as const).flatMap((value) => [
    { op: "eq" as const, key: "x", value },
    { op: "ne" as const, key: "x", value },
    { op: "in" as const, key: "x", values: [value] },
    { op: "nin" as const, key: "x", values: [value] },
    { op: "all" as const, key: "x", values: [value] },
  ]),
  ...(["gt", "gte", "lt", "lte"] as const).map((op) => ({
    op,
    key: "x",
    value: 0,
  })),
  { op: "exists", key: "x", value: true },
  { op: "exists", key: "x", value: false },
  { op: "eq", key: "a.b", value: "quoted" },
  { op: "eq", key: "quote' OR 1=1", value: true },
];
test("SQL and diagnostic truth tables agree, including negation, strict types and hostile keys", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id INTEGER,typed_metadata TEXT)");
  maps.forEach((map, i) =>
    db.run("INSERT INTO documents VALUES (?,?)", [i, JSON.stringify(map)])
  );
  const cases = [
    ...predicates,
    ...predicates.map(
      (predicate): MetadataPredicate => ({ op: "not", predicate })
    ),
    ...predicates.slice(0, 12).map(
      (predicate): MetadataPredicate => ({
        op: "and",
        predicates: [predicate, { op: "exists", key: "x", value: true }],
      })
    ),
    {
      op: "or",
      predicates: [
        { op: "eq", key: "x", value: false },
        { op: "eq", key: "x", value: "1" },
      ],
    } as MetadataPredicate,
    { op: "all", key: "x", values: [0, 1, 1] } as MetadataPredicate,
    { op: "in", key: "x", values: ["A", "B"] } as MetadataPredicate,
  ];
  for (const predicate of cases) {
    const compiled = compileMetadataPredicate(predicate);
    const actual = db
      .query<{ id: number }, (string | number)[]>(
        `SELECT d.id FROM documents d WHERE ${compiled.sql} ORDER BY d.id`
      )
      .all(...compiled.params)
      .map((row) => row.id);
    const expected = maps.flatMap((map, id) =>
      matchesMetadataPredicate(map, predicate) ? [id] : []
    );
    expect(actual).toEqual(expected);
  }
  // Explicit oracle checks prevent a shared semantic mistake from passing parity.
  expect(matchesMetadataPredicate({}, { op: "ne", key: "x", value: 1 })).toBe(
    false
  );
  expect(
    matchesMetadataPredicate(
      {},
      { op: "not", predicate: { op: "eq", key: "x", value: 1 } }
    )
  ).toBe(true);
  expect(
    matchesMetadataPredicate({ x: false }, { op: "eq", key: "x", value: 0 })
  ).toBe(false);
  expect(
    matchesMetadataPredicate({ x: "1" }, { op: "gt", key: "x", value: 0 })
  ).toBe(false);
  expect(
    matchesMetadataPredicate({ x: [] }, { op: "exists", key: "x", value: true })
  ).toBe(true);
  db.close();
});

test("bounded validation rejects cycles, unsupported data and excessive predicates", () => {
  const cycle: { op: "not"; predicate?: unknown } = { op: "not" };
  cycle.predicate = cycle;
  const bad = [
    cycle,
    { op: "and", predicates: [] },
    { op: "all", key: "x", values: [] },
    { op: "in", key: "x", values: [1, "1"] },
    { op: "eq", key: "__proto__", value: 1 },
    { op: "gt", key: "x", value: Infinity },
    { op: "gt", key: "x", value: "1" },
    { op: "eq", key: "x", value: 1, sql: "1=1" },
    {
      op: "and",
      predicates: Array.from({ length: 128 }, () => ({
        op: "eq",
        key: "x",
        value: 1,
      })),
    },
  ];
  for (const input of bad)
    expect(metadataPredicateSchema.safeParse(input).success).toBe(false);
  expect(typedMetadataSchema.safeParse({ when: new Date() }).success).toBe(
    false
  );
  expect(
    typedMetadataSchema.safeParse(JSON.parse('{"__proto__":"bad"}')).success
  ).toBe(false);
});

test("canonical predicates preserve semantics and set order", () => {
  expect(
    normalizeMetadataPredicate({
      op: "and",
      predicates: [
        { op: "in", key: "x", values: [2, 1, 2] },
        { op: "exists", key: "x", value: true },
      ],
    })
  ).toEqual(
    normalizeMetadataPredicate({
      op: "and",
      predicates: [
        { op: "exists", key: "x", value: true },
        { op: "in", key: "x", values: [1, 2] },
      ],
    })
  );
});
