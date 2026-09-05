/** Synthetic IPC child: accepts requests but ignores cancellation and shutdown. */
import {
  NativeFrameDecoder,
  frameNativeMessage,
  parseNativeRequest,
} from "../../src/llm/native-worker/protocol";
import { NativeRuntimeConfigSchema } from "../../src/llm/native-worker/runtime-config";

const config = NativeRuntimeConfigSchema.parse(JSON.parse(process.argv[2]!));
const decoder = new NativeFrameDecoder(config.generation);
process.on("message", (message: unknown) => {
  if (!(message instanceof Uint8Array)) return;
  const decoded = decoder.push(message);
  if (!decoded) return;
  const request = parseNativeRequest(decoded, config.generation, config.models);
  if (request.op === "init") {
    for (const frame of frameNativeMessage({
      version: 1,
      generation: request.generation,
      requestId: request.requestId,
      op: "init",
      result: { ok: true, value: { dimensions: 1, structuredOutput: "none" } },
    }))
      process.send?.(frame);
  } else {
    process.send?.({
      version: 1,
      generation: request.generation,
      requestId: request.requestId,
      executionStarted: true,
    });
  }
});
setInterval(() => {}, 1000);
process.send?.("ready");
