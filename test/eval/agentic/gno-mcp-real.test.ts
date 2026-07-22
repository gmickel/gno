import { expect, test } from "bun:test";

import { GnoMcpAdapter } from "../../../evals/agentic/adapters/gno-mcp";
import { loadAgenticFixture } from "../../../evals/agentic/fixture-db";
import {
  cleanupGnoMcpHandle,
  prepareGnoMcpHandle,
} from "../../../evals/agentic/lifecycle/gno-mcp";

test("opt-in real isolated GNO stdio MCP hybrid smoke", async () => {
  if (process.env.GNO_AGENTIC_RUN_REAL_MCP !== "1") {
    expect(process.env.GNO_AGENTIC_RUN_REAL_MCP).not.toBe("1");
    return;
  }
  const fixture = await loadAgenticFixture();
  const task = fixture.tasks.get("t0a1b2c3");
  if (!task) throw new Error("fixture task missing");
  const handle = await prepareGnoMcpHandle(fixture.snapshot);
  const adapter = new GnoMcpAdapter({
    prepareHandle: async () => handle,
    cleanupHandle: cleanupGnoMcpHandle,
  });
  try {
    await adapter.prepare({
      snapshot: fixture.snapshot,
      prepared: null,
      signal: new AbortController().signal,
    });
    await adapter.reset({
      task,
      lifecycle: "warm",
      readinessProbe: true,
      signal: new AbortController().signal,
    });
    const search = await adapter.callTool(
      "search",
      { query: "north gateway", collection: "c001", fast: true, limit: 3 },
      new AbortController().signal
    );
    expect(search.result.status).toBe("ok");
    expect(search.result.content).toContain('"vectorsUsed":true');
    expect(search.result.evidence.length).toBeGreaterThan(0);
    const uri = search.result.evidence[0]?.uri;
    if (!uri)
      throw new Error("real GNO query returned no exact fixture evidence");
    const read = await adapter.callTool(
      "get",
      { uri },
      new AbortController().signal
    );
    expect(read.result.evidence.length).toBeGreaterThan(0);
    expect(
      read.result.evidence.some((item) => item.text.includes("INC-4827"))
    ).toBe(true);
  } finally {
    await adapter.dispose();
  }
});
