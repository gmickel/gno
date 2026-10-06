/**
 * fn-203: the soak harness's deterministic parts and its process accounting.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { Corpus } from "../../scripts/soak/corpus";
import { fakeVector, startFakeLlm } from "../../scripts/soak/fake-llm";
import { parseArgs, parseDuration } from "../../scripts/soak/index";
import {
  maxAttemptsPerWindow,
  percentile,
  slope,
  Verdicts,
} from "../../scripts/soak/invariants";
import { isAlive } from "../../scripts/soak/procfs";
import { createRng } from "../../scripts/soak/rng";
import {
  createSandbox,
  killAllTagged,
  removeSandbox,
  type Sandbox,
  spawnTagged,
  sweepTagged,
} from "../../scripts/soak/sandbox";

const sandboxes: Sandbox[] = [];

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    await killAllTagged(sandbox);
    await removeSandbox(sandbox);
  }
});

describe("rng", () => {
  test("a seed reproduces the same stream, forks are independent and stable", () => {
    const a = createRng(42);
    const b = createRng(42);
    const draws = Array.from({ length: 5 }, () => a.int(0, 1_000));
    expect(Array.from({ length: 5 }, () => b.int(0, 1_000))).toEqual(draws);
    expect(createRng(42).fork("x").next()).toBe(createRng(42).fork("x").next());
    expect(createRng(42).fork("x").next()).not.toBe(
      createRng(42).fork("y").next()
    );
  });
});

describe("invariant math", () => {
  test("max attempts counts the densest 10-minute window per path", () => {
    const minute = 60_000;
    const rows = [
      ...[0, 1, 2, 3, 4].map((m) => ({ key: "c/a.md", t: m * minute })),
      ...[0, 11, 22].map((m) => ({ key: "c/b.md", t: m * minute })),
    ];
    expect(maxAttemptsPerWindow(rows)).toEqual({ key: "c/a.md", attempts: 5 });
    // A fixed 500 ms retry for 10 minutes is ~1200 attempts.
    const spin = Array.from({ length: 1_200 }, (_, i) => ({
      key: "c/x.md",
      t: i * 500,
    }));
    expect(maxAttemptsPerWindow(spin).attempts).toBeGreaterThan(1_000);
  });

  test("slope and percentile", () => {
    expect(
      slope([
        { x: 0, y: 1 },
        { x: 10, y: 21 },
      ])
    ).toBeCloseTo(2);
    expect(slope([{ x: 0, y: 5 }])).toBe(0);
    expect(percentile([1, 2, 3, 4, 100], 99)).toBe(100);
    expect(percentile([], 99)).toBe(0);
  });

  test("an invariant fails when any observation failed and skips when none ran", () => {
    const verdicts = new Verdicts();
    verdicts.observe("I1", true, "ok");
    verdicts.observe("I1", false, "busy");
    verdicts.skip("I6", "too short");
    const byId = Object.fromEntries(
      verdicts.summary().map((s) => [s.id, s.status])
    );
    expect(byId.I1).toBe("fail");
    expect(byId.I6).toBe("skip");
    expect(byId.I2).toBe("skip");
  });
});

describe("cli", () => {
  test("durations and arguments", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("4h")).toBe(14_400_000);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(() => parseDuration("soon")).toThrow();
    const cli = parseArgs([
      "--tier",
      "torture",
      "--seed",
      "7",
      "--classes",
      "signals,sse-flood",
      "--keep",
    ]);
    expect(cli.options).toMatchObject({
      tier: "torture",
      seed: 7,
      classes: ["signals", "sse-flood"],
    });
    expect(cli.keep).toBe(true);
    expect(() => parseArgs(["--tier", "nope"])).toThrow("unknown tier");
    expect(() => parseArgs(["--classes", "bogus"])).toThrow(
      "unknown torture class"
    );
  });
});

describe("fake model server", () => {
  test("serves embeddings and injected faults", async () => {
    const llm = startFakeLlm(() => 0);
    try {
      const embed = async () =>
        fetch(`${llm.baseUrl}/embeddings`, {
          method: "POST",
          body: JSON.stringify({ input: ["alpha beta", "gamma"] }),
        });
      const ok = (await (await embed()).json()) as {
        data: { embedding: number[] }[];
      };
      expect(ok.data).toHaveLength(2);
      expect(ok.data[0]?.embedding).toEqual(fakeVector("alpha beta"));
      await llm.setFaults({ errorRate: 1 });
      expect((await embed()).status).toBe(500);
      await llm.setFaults({ errorRate: 0, down: true });
      let refused = false;
      try {
        await embed();
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      await llm.setFaults({ down: false });
      expect((await embed()).status).toBe(200);
    } finally {
      llm.stop();
    }
  });
});

describe("sandbox", () => {
  // The harness is POSIX-only (/proc or ps, sh, lockf/flock).
  test.skipIf(process.platform === "win32")(
    "tagged processes are found by the run marker and killed at teardown",
    async () => {
      const sandbox = await createSandbox(`test-${Date.now().toString(36)}`);
      sandboxes.push(sandbox);
      expect(sandbox.env.HOME?.startsWith(sandbox.root)).toBe(true);
      expect(sandbox.env.GNO_DATA_DIR?.startsWith(sandbox.root)).toBe(true);
      // A grandchild the harness never saw: still found through the marker.
      const parent = spawnTagged(sandbox, ["sh", "-c", "sleep 60 & wait"]);
      await Bun.sleep(300);
      const found = await sweepTagged(sandbox);
      expect(found.length).toBeGreaterThanOrEqual(2);
      expect(found.some((info) => info.pid === parent.pid)).toBe(true);
      const killed = await killAllTagged(sandbox);
      expect(killed.length).toBe(found.length);
      for (const info of killed) expect(isAlive(info.pid)).toBe(false);
      expect(await sweepTagged(sandbox)).toHaveLength(0);
    }
  );
});

describe("corpus", () => {
  test("expected state follows renames, directory moves and deletes", async () => {
    const sandbox = await createSandbox(`corpus-${Date.now().toString(36)}`);
    sandboxes.push(sandbox);
    const corpus = new Corpus(sandbox.corpusDir, createRng(3));
    await corpus.generate(40);
    expect(await corpus.walkNotes()).toEqual([...corpus.live.keys()].sort());
    await corpus.moveDir("d1", "moved/d1");
    await corpus.deleteDir("d2");
    await corpus.renameNote("d3/note-3.md", "d4/renamed.md");
    await corpus.atomicSave("d4/renamed.md");
    expect(await corpus.walkNotes()).toEqual([...corpus.live.keys()].sort());
    const marker = corpus.live.get("d4/renamed.md") as string;
    expect(
      await Bun.file(`${corpus.layout.notes}/d4/renamed.md`).text()
    ).toContain(marker);
    await corpus.unlockEdge();
  });
});
