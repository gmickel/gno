export type DocumentEventOrigin = "watcher" | "save" | "create";

export interface DocumentEvent {
  type: "document-changed";
  uri: string;
  collection: string;
  relPath: string;
  origin: DocumentEventOrigin;
  changedAt: string;
}

export interface DocumentEventBusState {
  connectedClients: number;
  retryMs: number;
}

const encoder = new TextEncoder();
const EVENT_RETRY_MS = 2_000;
const KEEPALIVE_MS = 15_000;

export class DocumentEventBus {
  readonly #controllers = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();

  createResponse(): Response {
    const controllers = this.#controllers;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controllers.add(controller);
        controller.enqueue(
          encoder.encode(`retry: ${EVENT_RETRY_MS}\n: connected\n\n`)
        );
        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
            }
            controllers.delete(controller);
          }
        }, KEEPALIVE_MS);
      },
      cancel() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
        }
        if (streamController) {
          controllers.delete(streamController);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  emit(event: DocumentEvent): void {
    const payload = encoder.encode(
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    );

    for (const controller of this.#controllers) {
      try {
        controller.enqueue(payload);
      } catch {
        this.#controllers.delete(controller);
      }
    }
  }

  close(): void {
    for (const controller of this.#controllers) {
      try {
        controller.close();
      } catch {
        // Best-effort shutdown.
      }
    }
    this.#controllers.clear();
  }

  getState(): DocumentEventBusState {
    return {
      connectedClients: this.#controllers.size,
      retryMs: EVENT_RETRY_MS,
    };
  }
}
