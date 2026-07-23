import { describe, expect, test } from "bun:test";

import { DocumentEventBus } from "../../src/serve/doc-events";
import { assertValid, loadSchema } from "../spec/schemas/validator";

describe("DocumentEventBus", () => {
  test("emits a closed metadata-only Capsule reverification event", async () => {
    const bus = new DocumentEventBus();
    const response = bus.createResponse();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) {
      throw new Error("Expected SSE response body");
    }

    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain(
      "retry: 2000\n: connected"
    );

    bus.emit({
      type: "capsule-reverified",
      registrationId: `capsule-${"a".repeat(40)}`,
      capsuleId: "b".repeat(64),
      operationStatus: "completed",
      affectedQuestionState: "affected",
      changedAt: "2026-07-23T12:00:00.000Z",
    });

    const emitted = await reader.read();
    const frame = new TextDecoder().decode(emitted.value);
    expect(frame.startsWith("event: capsule-reverified\ndata: ")).toBe(true);
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "null");
    expect(Object.keys(payload).sort()).toEqual([
      "affectedQuestionState",
      "capsuleId",
      "changedAt",
      "operationStatus",
      "registrationId",
      "type",
    ]);
    expect(
      assertValid(payload, await loadSchema("capsule-reverified-event"))
    ).toBe(true);

    await reader.cancel();
    expect(bus.getState().connectedClients).toBe(0);
    bus.close();
  });
});
