import { describe, expect, test } from "bun:test";

import type { Collection } from "../../src/config/types";

import { CollectionWatchService } from "../../src/serve/watch-service";

function createCollection(name: string, path: string): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
}

describe("CollectionWatchService", () => {
  test("updateCollections adds new watchers and removes stale ones", () => {
    const closed: string[] = [];
    const watchCalls: string[] = [];

    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit: () => undefined } as never,
      scheduler: null,
      store: {} as never,
      watchFactory: ((path: string) => {
        watchCalls.push(path);
        return {
          close: () => {
            closed.push(path);
          },
        };
      }) as never,
    });

    service.start();
    expect(service.getState().activeCollections).toEqual(["notes"]);

    service.updateCollections([
      createCollection("work", "/tmp/work"),
      createCollection("notes", "/tmp/notes"),
    ]);

    expect(service.getState().activeCollections.sort()).toEqual([
      "notes",
      "work",
    ]);
    expect(watchCalls).toEqual(["/tmp/notes", "/tmp/work"]);

    service.updateCollections([createCollection("work", "/tmp/work")]);
    expect(service.getState().activeCollections).toEqual(["work"]);
    expect(closed).toEqual(["/tmp/notes"]);
  });

  test("failed watcher starts are surfaced in state", () => {
    const service = new CollectionWatchService({
      collections: [createCollection("notes", "/tmp/notes")],
      eventBus: { emit: () => undefined } as never,
      scheduler: null,
      store: {} as never,
      watchFactory: (() => {
        throw new Error("recursive watch unavailable");
      }) as never,
    });

    service.start();

    expect(service.getState().failedCollections).toEqual([
      { collection: "notes", reason: "recursive watch unavailable" },
    ]);
  });
});
