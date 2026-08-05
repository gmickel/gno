export type DocumentEventOrigin = "watcher" | "save" | "create";

export interface DocumentChangedEvent {
  type: "document-changed";
  /**
   * `gno://<collection>/<relPath>` - the path that changed. Fetchable as a
   * document only when `kind` is absent or `"document"`; for a record container
   * it names the FILE and resolves to no document (see `recordUris`).
   */
  uri: string;
  collection: string;
  relPath: string;
  origin: DocumentEventOrigin;
  changedAt: string;
  /**
   * What `uri` actually is, when the emitter proved it. Absent from emitters
   * that do not run the proof (the watcher), so consumers must treat an absent
   * `kind` as "unknown", not as "document".
   */
  kind?: "document" | "record-container";
  /**
   * The fetchable URIs of a record container's logical records - the handles a
   * consumer can use in place of the unresolvable `uri`.
   *
   * BOUNDED (`MAX_WRITTEN_RECORD_URIS`), and deliberately so: this frame is
   * JSON-encoded once per connected client on every write, which is the worst
   * possible place for a list whose length is the container's record count.
   * `recordCount` is exact and `recordUrisTruncated` says what this page omits.
   * The omitted records are not carried BY the frame - there is no dedicated
   * per-container enumeration endpoint, so the frame promises no continuation.
   * They are still reachable: every record URI shares the container's virtual
   * `.gno/records/<id>/` prefix, which a prefix-scoped listing enumerates, and
   * ordinary collection paging returns every logical record with `relPath`
   * projected from the container's own path.
   */
  recordUris?: string[];
  /** Exact number of logical records the container is indexed as. */
  recordCount?: number;
  /** `recordCount - recordUris.length`: records this frame does not list. */
  recordUrisTruncated?: number;
}

export interface CapsuleReverifiedEvent {
  type: "capsule-reverified";
  registrationId: string;
  capsuleId: string;
  operationStatus: "completed" | "failed";
  affectedQuestionState: "unaffected" | "affected" | "unknown";
  changedAt: string;
}

export type DocumentEvent = DocumentChangedEvent | CapsuleReverifiedEvent;

export interface DocumentEventBusState {
  connectedClients: number;
  retryMs: number;
}

export interface DocumentEventStreamAuthorization {
  authorizationEpoch: string;
  isAuthorizationEpochCurrent: () => boolean;
  onClose?: () => void;
  signal?: AbortSignal;
}

interface DocumentEventSubscriber {
  authorization: DocumentEventStreamAuthorization;
  closed: boolean;
  controller: ReadableStreamDefaultController<Uint8Array>;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  removeAbortListener: (() => void) | null;
}

const encoder = new TextEncoder();
const EVENT_RETRY_MS = 2_000;
const KEEPALIVE_MS = 15_000;
const POLICY_CHANGED_FRAME = encoder.encode(
  `retry: ${EVENT_RETRY_MS}\nevent: egress-policy-changed\ndata: {"error":{"code":"EGRESS_POLICY_CHANGED","message":"Collection policy changed; retry"}}\n\n`
);

export class DocumentEventBus {
  readonly #subscribers = new Set<DocumentEventSubscriber>();
  readonly #keepaliveMs: number;

  constructor(options: { keepaliveMs?: number } = {}) {
    this.#keepaliveMs = options.keepaliveMs ?? KEEPALIVE_MS;
  }

  createResponse(
    authorization: DocumentEventStreamAuthorization = {
      authorizationEpoch: "unrestricted",
      isAuthorizationEpochCurrent: () => true,
    }
  ): Response {
    let subscriber: DocumentEventSubscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = {
          authorization,
          closed: false,
          controller,
          keepaliveTimer: null,
          removeAbortListener: null,
        };
        this.#subscribers.add(subscriber);
        if (!authorization.isAuthorizationEpochCurrent()) {
          this.#invalidateSubscriber(subscriber);
          return;
        }
        controller.enqueue(
          encoder.encode(`retry: ${EVENT_RETRY_MS}\n: connected\n\n`)
        );
        subscriber.keepaliveTimer = setInterval(
          () => {
            if (!authorization.isAuthorizationEpochCurrent()) {
              this.#invalidateSubscriber(subscriber);
              return;
            }
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              this.#closeSubscriber(subscriber);
            }
          },
          this.#keepaliveMs
        );
        if (authorization.signal) {
          const onAbort = (): void => this.#closeSubscriber(subscriber);
          authorization.signal.addEventListener("abort", onAbort, {
            once: true,
          });
          subscriber.removeAbortListener = () =>
            authorization.signal?.removeEventListener("abort", onAbort);
          if (authorization.signal.aborted) onAbort();
        }
      },
      cancel: () => {
        this.#closeSubscriber(subscriber, false);
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

    for (const subscriber of this.#subscribers) {
      if (!subscriber.authorization.isAuthorizationEpochCurrent()) {
        this.#invalidateSubscriber(subscriber);
        continue;
      }
      try {
        subscriber.controller.enqueue(payload);
      } catch {
        this.#closeSubscriber(subscriber);
      }
    }
  }

  close(): void {
    for (const subscriber of this.#subscribers) {
      this.#closeSubscriber(subscriber);
    }
  }

  getState(): DocumentEventBusState {
    return {
      connectedClients: this.#subscribers.size,
      retryMs: EVENT_RETRY_MS,
    };
  }

  #invalidateSubscriber(subscriber: DocumentEventSubscriber | null): void {
    if (!subscriber || subscriber.closed) return;
    try {
      subscriber.controller.enqueue(POLICY_CHANGED_FRAME);
    } catch {
      // The stream may already be cancelled.
    }
    this.#closeSubscriber(subscriber);
  }

  #closeSubscriber(
    subscriber: DocumentEventSubscriber | null,
    closeController = true
  ): void {
    if (!subscriber || subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.keepaliveTimer) {
      clearInterval(subscriber.keepaliveTimer);
    }
    subscriber.removeAbortListener?.();
    this.#subscribers.delete(subscriber);
    if (closeController) {
      try {
        subscriber.controller.close();
      } catch {
        // Best-effort stream shutdown.
      }
    }
    subscriber.authorization.onClose?.();
  }
}
