import { useEffect, useState } from "react";

export interface DocumentEvent {
  type: "document-changed";
  uri: string;
  collection: string;
  relPath: string;
  origin: "watcher" | "save" | "create";
  changedAt: string;
}

export function useDocEvents(): DocumentEvent | null {
  const [event, setEvent] = useState<DocumentEvent | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    const handleEvent = (incoming: Event) => {
      const message = incoming as MessageEvent<string>;
      try {
        setEvent(JSON.parse(message.data) as DocumentEvent);
      } catch {
        // Ignore malformed event payloads.
      }
    };

    source.addEventListener("document-changed", handleEvent);
    return () => {
      source.removeEventListener("document-changed", handleEvent);
      source.close();
    };
  }, []);

  return event;
}
