declare module "electrobun" {
  export interface ElectrobunConfig {
    app: {
      name: string;
      identifier: string;
      version: string;
      urlSchemes?: string[];
    };
    runtime?: Record<string, unknown>;
    build?: Record<string, unknown>;
  }
}

declare module "electrobun/bun" {
  export const ApplicationMenu: {
    setApplicationMenu(menu: unknown): void;
  };

  export const BuildConfig: {
    get(): Promise<{ runtime?: Record<string, unknown> }>;
  };

  export class BrowserWindow {
    constructor(options: unknown);
    show(): void;
    focus(): void;
    webview: {
      loadURL(url: string): void;
    };
  }

  export const GlobalShortcut: {
    register(shortcut: string, handler: () => void): boolean;
  };

  const Electrobun: {
    events: {
      on(name: string, handler: (event: unknown) => void): void;
    };
  };

  export default Electrobun;
}
