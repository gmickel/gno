import { NativeDispatcher } from "./dispatcher";
import { NativeWorkerError } from "./errors";
import {
  frameNativeMessage,
  NativeFrameDecoder,
  parseNativeRequest,
} from "./protocol";
import {
  NativeAckSchema,
  NativeRegistrationSchema,
  NativeRuntimeConfigSchema,
} from "./runtime-config";

const config = NativeRuntimeConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null")
);
if (!process.send) throw new Error("Native worker requires parent IPC");
const dispatcher = new NativeDispatcher(config);
const decoder = new NativeFrameDecoder(config.generation);
let active: Promise<void> | undefined;
let awaitingAck: number | undefined;
let closing: Promise<void> | undefined;
let lastActivity = Date.now();
let activity = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function armIdle(): void {
  clearTimeout(idleTimer);
  if (active || awaitingAck || closing) return;
  idleTimer = setTimeout(
    () => process.send?.("idle"),
    Math.max(0, lastActivity + config.warmModelTtl - Date.now())
  );
}

function shutdown(): Promise<void> {
  if (closing) return closing;
  clearTimeout(idleTimer);
  // Finite termination also covers stuck native work and disconnected parents.
  const force = setTimeout(() => process.exit(1), 900);
  closing = (async () => {
    try {
      await active;
      await dispatcher.dispose();
      clearTimeout(force);
      process.exit(0);
    } catch {
      process.exit(1);
    }
  })();
  return closing;
}

process.on("disconnect", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("message", (message: unknown) => {
  if (closing) return;
  if (message === "shutdown") {
    void shutdown();
    return;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "register" in message
  ) {
    const parsed = NativeRegistrationSchema.safeParse(message);
    if (
      !parsed.success ||
      config.models.some((model) => model.id === parsed.data.register.id)
    ) {
      void shutdown();
      return;
    }
    const updated = NativeRuntimeConfigSchema.safeParse({
      ...config,
      models: [...config.models, parsed.data.register],
    });
    if (!updated.success) {
      void shutdown();
      return;
    }
    config.models.push(parsed.data.register);
    return;
  }
  if (typeof message === "object" && message !== null && "ack" in message) {
    if (
      !NativeAckSchema.safeParse(message).success ||
      message.ack !== awaitingAck ||
      awaitingAck === undefined
    ) {
      void shutdown();
      return;
    }
    awaitingAck = undefined;
    if (activity) lastActivity = Date.now();
    activity = false;
    armIdle();
    return;
  }
  try {
    if (!(message instanceof Uint8Array) || active || awaitingAck)
      throw new NativeWorkerError("protocol");
    clearTimeout(idleTimer);
    const decoded = decoder.push(message);
    if (decoded === undefined) return;
    const request = parseNativeRequest(
      decoded,
      config.generation,
      config.models
    );
    active = (async () => {
      const result = await dispatcher.execute(request);
      activity = result.activity;
      awaitingAck = request.requestId;
      for (const frame of frameNativeMessage(result.response))
        process.send?.(frame);
    })()
      .catch(() => {
        void shutdown();
      })
      .finally(() => {
        active = undefined;
      });
  } catch {
    void shutdown();
  }
});
process.send("ready");
armIdle();
