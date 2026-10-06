/**
 * Loopback OpenAI-compatible model server for the soak harness: embeddings,
 * chat completions and completions, with faults that can be switched at
 * runtime (latency, error rate, hangs, malformed bodies, outage).
 *
 * @module scripts/soak/fake-llm
 */

export const FAKE_DIMENSIONS = 64;

export interface FakeLlmFaults {
  latencyMs: number;
  /** Probability of an HTTP 500. */
  errorRate: number;
  /** Requests never answer while true (until the fault is cleared). */
  hang: boolean;
  /** Probability of a 200 with an unparseable body. */
  malformedRate: number;
  /** Refuse connections (server stopped) while true. */
  down: boolean;
}

export interface FakeLlm {
  port: number;
  baseUrl: string;
  faults: FakeLlmFaults;
  setFaults(next: Partial<FakeLlmFaults>): Promise<void>;
  stats(): { requests: number; embeddedTexts: number; errors: number };
  stop(): void;
}

const NO_FAULTS: FakeLlmFaults = {
  latencyMs: 0,
  errorRate: 0,
  hang: false,
  malformedRate: 0,
  down: false,
};

/** Deterministic unit-ish vector from text, so similar text gets similar vectors. */
export function fakeVector(text: string): number[] {
  const vector = Array.from({ length: FAKE_DIMENSIONS }, () => 0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (!word) continue;
    let hash = 2_166_136_261;
    for (const char of word)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619);
    const slot = (hash >>> 0) % FAKE_DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function startFakeLlm(random: () => number = Math.random): FakeLlm {
  const faults: FakeLlmFaults = { ...NO_FAULTS };
  const counters = { requests: 0, embeddedTexts: 0, errors: 0 };
  const hanging = new Set<() => void>();
  let server: ReturnType<typeof Bun.serve> | null = null;
  let port = 0;

  const handle = async (req: Request): Promise<Response> => {
    counters.requests += 1;
    if (faults.latencyMs > 0) await Bun.sleep(faults.latencyMs);
    if (faults.hang) {
      await new Promise<void>((resolveHang) => hanging.add(resolveHang));
    }
    if (random() < faults.errorRate) {
      counters.errors += 1;
      return new Response("injected failure", { status: 500 });
    }
    if (random() < faults.malformedRate) {
      return new Response("{not json", {
        headers: { "content-type": "application/json" },
      });
    }
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (path.endsWith("/embeddings")) {
      const input = body.input;
      const inputs = Array.isArray(input)
        ? input.map((item) =>
            typeof item === "string" ? item : JSON.stringify(item)
          )
        : [typeof input === "string" ? input : ""];
      counters.embeddedTexts += inputs.length;
      return Response.json({
        object: "list",
        model: "fake",
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: fakeVector(text),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    }
    if (path.endsWith("/chat/completions")) {
      return Response.json({
        id: "fake",
        object: "chat.completion",
        model: "fake",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Not enough evidence in the fake model.",
            },
          },
        ],
      });
    }
    if (path.endsWith("/completions")) {
      return Response.json({
        id: "fake",
        object: "text_completion",
        model: "fake",
        choices: [{ index: 0, text: "yes", finish_reason: "stop" }],
      });
    }
    return new Response("not found", { status: 404 });
  };

  const listen = (): void => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: handle,
      idleTimeout: 0,
    });
    port = server.port as number;
  };
  listen();

  return {
    get port() {
      return port;
    },
    get baseUrl() {
      return `http://127.0.0.1:${port}/v1`;
    },
    faults,
    async setFaults(next) {
      Object.assign(faults, next);
      if (!faults.hang) {
        for (const release of hanging) release();
        hanging.clear();
      }
      if (faults.down && server) {
        void server.stop(true);
        server = null;
      } else if (!faults.down && !server) {
        listen();
      }
    },
    stats: () => ({ ...counters }),
    stop() {
      for (const release of hanging) release();
      void server?.stop(true);
      server = null;
    },
  };
}

/** Model preset block pointing every role at the fake server. */
export function fakePreset(baseUrl: string): Record<string, unknown> {
  return {
    activePreset: "soak-fake",
    presets: [
      {
        id: "soak-fake",
        name: "Soak fake loopback",
        embed: `${baseUrl}/embeddings#fake`,
        rerank: `${baseUrl}/completions#fake`,
        expand: `${baseUrl}/chat/completions#fake`,
        gen: `${baseUrl}/chat/completions#fake`,
      },
    ],
  };
}
