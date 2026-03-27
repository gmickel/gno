import { useEffect, useState } from "react";

export interface DocumentEvent {
  type: "document-changed";
  uri: string;
  collection: string;
  relPath: string;
  origin: "watcher" | "save" | "create";
  changedAt: string;
}

export function getEventStreamRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 10_000);
}

export function useDocEvents(): DocumentEvent | null {
  const [event, setEvent] = useState<DocumentEvent | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let reconnectAttempt = 0;

    const cleanupSource = () => {
      if (!source) {
        return;
      }
      source.removeEventListener("document-changed", handleEvent);
      source.onerror = null;
      source.close();
      source = null;
    };

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) {
        return;
      }
      const delay = getEventStreamRetryDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const handleEvent = (incoming: Event) => {
      const message = incoming as MessageEvent<string>;
      try {
        setEvent(JSON.parse(message.data) as DocumentEvent);
        reconnectAttempt = 0;
      } catch {
        // Ignore malformed event payloads.
      }
    };

    const connect = () => {
      cleanupSource();
      source = new EventSource("/api/events");
      source.addEventListener("document-changed", handleEvent);
      source.onerror = () => {
        cleanupSource();
        scheduleReconnect();
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      cleanupSource();
    };
  }, []);

  return event;
}
