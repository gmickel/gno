interface ChromeStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  setAccessLevel?(input: {
    accessLevel: "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";
  }): Promise<void>;
}

interface ChromeRuntime {
  id: string;
  getURL(path: string): string;
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void
      ) => boolean | void
    ): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
}

interface ChromeApi {
  runtime: ChromeRuntime;
  storage: { local: ChromeStorageArea; session: ChromeStorageArea };
  tabs: {
    create(input: { url: string }): Promise<unknown>;
    query(input: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript<T>(input: {
      target: { tabId: number; allFrames?: boolean };
      func?: () => T;
      files?: string[];
    }): Promise<Array<{ frameId: number; result?: T }>>;
  };
}

declare const chrome: ChromeApi;
