/**
 * Scoped supersession walk (`getSupersedingUris` with `canFollow`): cycles,
 * fail-closed answers, bounded work, and agreement with the unscoped walk.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SupersessionOptions } from "../../src/store/types";

import {
  MAX_SCOPED_SUPERSESSION_HOPS,
  SqliteAdapter,
} from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const CHAIN_LENGTH = 200;
const CYCLE_NODES = ["self", "two-a", "two-b", "tail-a", "tail-b", "tail-c"];
const GRAPH_NODES = ["g0", "g1", "g2", "g3"];

const uri = (name: string) => `gno://notes/${name}.md`;
const chainNode = (index: number) => `chain-${index}`;

const store = new SqliteAdapter();
let directory: string;
const ids = new Map<string, number>();

/** Make each `successor` supersede its `predecessors` (replacing old edges). */
const supersede = async (
  successor: string,
  predecessors: string[]
): Promise<void> => {
  const result = await store.setDocEdges(
    ids.get(successor) as number,
    predecessors.map((predecessor) => ({
      targetDocId: ids.get(predecessor) as number,
      edgeType: "supersedes" as const,
      confidence: "parsed" as const,
    })),
    "frontmatter-relation"
  );
  expect(result.ok).toBe(true);
};

/** `canFollow` that admits `allowed` and records every call. */
const recording = (allowed: (target: string) => boolean) => {
  const calls: string[][] = [];
  const options: SupersessionOptions = {
    canFollow: async (uris) => {
      calls.push([...uris]);
      return new Set(uris.filter(allowed));
    },
  };
  return { calls, options };
};

/** Count the supersession successor queries one lookup runs. */
const countingSuccessorQueries = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; queries: number }> => {
  const db = store.getRawDb();
  const query = db.query.bind(db);
  let queries = 0;
  db.query = ((sql: string) => {
    const statement = query(sql);
    if (!sql.includes("'supersedes'")) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "all" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          queries += 1;
          return value.apply(target, args);
        };
      },
    });
  }) as typeof db.query;
  try {
    return { value: await run(), queries };
  } finally {
    // Back to the prototype method.
    Reflect.deleteProperty(db, "query");
  }
};

const lookup = async (inputs: string[], options?: SupersessionOptions) => {
  const result = await store.getSupersedingUris(inputs, options);
  if (!result.ok) throw new Error(result.error.message);
  return Object.fromEntries(result.value);
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "supersession-walk-"));
  expect(
    (await store.open(join(directory, "index-default.sqlite"), "unicode61")).ok
  ).toBe(true);
  expect(
    (
      await store.syncCollections([
        {
          name: "notes",
          path: "/tmp/notes",
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);
  const names = [
    ...CYCLE_NODES,
    ...GRAPH_NODES,
    ...Array.from({ length: CHAIN_LENGTH + 1 }, (_, index) => chainNode(index)),
  ];
  for (const name of names) {
    const inserted = await store.upsertDocument({
      collection: "notes",
      relPath: `${name}.md`,
      sourceHash: `hash-${name}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 1,
      sourceMtime: "2026-10-01T00:00:00.000Z",
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    ids.set(name, inserted.value.id);
  }
  // self -> self; two-a <-> two-b; tail-a -> tail-b -> tail-c -> tail-b.
  await supersede("self", ["self"]);
  await supersede("two-b", ["two-a"]);
  await supersede("two-a", ["two-b"]);
  await supersede("tail-b", ["tail-a", "tail-c"]);
  await supersede("tail-c", ["tail-b"]);
  // chain-0 -> chain-1 -> ... -> chain-CHAIN_LENGTH.
  for (let index = 1; index <= CHAIN_LENGTH; index += 1) {
    await supersede(chainNode(index), [chainNode(index - 1)]);
  }
});

afterAll(async () => {
  await store.close();
  await safeRm(directory);
});

describe("bounded work", () => {
  test("a rejected first successor costs one query and one check", async () => {
    const { calls, options } = recording(() => false);
    const { value, queries } = await countingSuccessorQueries(() =>
      lookup([uri(chainNode(0))], options)
    );
    expect(value).toEqual({});
    expect(queries).toBe(1);
    expect(calls).toEqual([[uri(chainNode(1))]]);
  });

  test("a chain at the hop limit names nothing", async () => {
    const { calls, options } = recording(() => true);
    const { value, queries } = await countingSuccessorQueries(() =>
      lookup([uri(chainNode(0))], options)
    );
    expect(value).toEqual({});
    expect(queries).toBe(MAX_SCOPED_SUPERSESSION_HOPS);
    expect(calls).toHaveLength(MAX_SCOPED_SUPERSESSION_HOPS);
    // The unscoped walk still follows the whole chain.
    expect(await lookup([uri(chainNode(0))])).toEqual({
      [uri(chainNode(0))]: uri(chainNode(CHAIN_LENGTH)),
    });
  });

  test("one hop checks every chain in one call", async () => {
    const end = CHAIN_LENGTH;
    const starts = Array.from({ length: 20 }, (_, index) =>
      uri(chainNode(end - 3 - index))
    );
    const { calls, options } = recording(() => true);
    const { value, queries } = await countingSuccessorQueries(() =>
      lookup(starts, options)
    );
    expect(Object.values(value)).toEqual(starts.map(() => uri(chainNode(end))));
    // 20 overlapping chains of up to 22 hops: each successor is looked up
    // and asked about once, the first hop for all 20 chains together.
    expect(calls.map((batch) => batch.length)).toEqual([20, 1, 1]);
    expect(queries).toBe(4);
  });
});

describe("agreement with the unscoped walk", () => {
  /** The unscoped walk over a successor map, as upstream implements it. */
  const unscopedEnd = (
    start: string,
    next: ReadonlyMap<string, string>
  ): string | undefined => {
    const visited = new Set([start]);
    let current = next.get(start);
    while (current && next.has(current) && !visited.has(current)) {
      visited.add(current);
      current = next.get(current);
    }
    return current && current !== start ? current : undefined;
  };

  test("every 4-note successor graph and rejection set", async () => {
    const nodes = GRAPH_NODES.map(uri);
    const choices = [undefined, ...GRAPH_NODES] as const;
    let compared = 0;
    for (let code = 0; code < choices.length ** GRAPH_NODES.length; code += 1) {
      // next[i] is the successor of GRAPH_NODES[i] in this graph.
      const next = GRAPH_NODES.map(
        (_, index) =>
          choices[Math.floor(code / choices.length ** index) % choices.length]
      );
      for (const successor of GRAPH_NODES) {
        await supersede(
          successor,
          GRAPH_NODES.filter((_, index) => next[index] === successor)
        );
      }
      const successors = new Map<string, string>();
      for (const [index, successor] of next.entries()) {
        if (successor) successors.set(nodes[index] as string, uri(successor));
      }
      const expectedUnscoped = Object.fromEntries(
        nodes.flatMap((start) => {
          const end = unscopedEnd(start, successors);
          return end ? [[start, end]] : [];
        })
      );
      expect(await lookup(nodes)).toEqual(expectedUnscoped);
      for (let mask = 0; mask < 2 ** nodes.length; mask += 1) {
        const rejected = new Set(
          nodes.filter((_, index) => (mask >> index) & 1)
        );
        // Scoped = unscoped on the graph without edges into rejected notes
        // (a chain's own start is never asked about).
        const expected = Object.fromEntries(
          nodes.flatMap((start) => {
            const kept = new Map(
              [...successors].filter(
                ([, target]) => target === start || !rejected.has(target)
              )
            );
            const end = unscopedEnd(start, kept);
            return end ? [[start, end]] : [];
          })
        );
        const { options } = recording((target) => !rejected.has(target));
        expect(await lookup(nodes, options)).toEqual(expected);
        compared += 1;
      }
    }
    expect(compared).toBe(625 * 16);
  });
});
