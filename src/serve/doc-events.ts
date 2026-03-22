export type DocumentEventOrigin = "watcher" | "save" | "create";

export interface DocumentEvent {
  type: "document-changed";
  uri: string;
  collection: string;
  relPath: string;
  origin: DocumentEventOrigin;
  changedAt: string;
}

const encoder = new TextEncoder();

export class DocumentEventBus {
  readonly #controllers = new Set<
    ReadableStreamDefaultController<Uint8Array>
  >();

  createResponse(): Response {
    const controllers = this.#controllers;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controllers.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
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
}
