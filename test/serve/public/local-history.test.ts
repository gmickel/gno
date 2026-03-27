import { describe, expect, test } from "bun:test";

import {
  appendLocalHistory,
  loadLatestLocalHistory,
  loadLocalHistory,
} from "../../../src/serve/public/lib/local-history";

function createStorage() {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("local history", () => {
  test("appends newest snapshots first", () => {
    const storage = createStorage();
    appendLocalHistory("#doc", "first", storage);
    appendLocalHistory("#doc", "second", storage);

    const history = loadLocalHistory("#doc", storage);
    expect(history).toHaveLength(2);
    expect(history[0]?.content).toBe("second");
    expect(history[1]?.content).toBe("first");
  });

  test("deduplicates identical content", () => {
    const storage = createStorage();
    appendLocalHistory("#doc", "same", storage);
    appendLocalHistory("#doc", "same", storage);

    expect(loadLocalHistory("#doc", storage)).toHaveLength(1);
    expect(loadLatestLocalHistory("#doc", storage)?.content).toBe("same");
  });
});
