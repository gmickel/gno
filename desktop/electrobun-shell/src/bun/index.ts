// @ts-nocheck
// @ts-ignore electrobun is installed per-package in desktop/electrobun-shell
import Electrobun, {
  ApplicationMenu,
  BuildConfig,
  BrowserWindow,
  GlobalShortcut,
  Utils,
} from "electrobun/bun";
// node:fs: sync existence checks for packaged runtime artifacts.
import { existsSync } from "node:fs";
// node:path has no Bun equivalent.
import { join, resolve } from "node:path";

import {
  DEFAULT_GNO_RUNTIME_FOLDER,
  getBundledBunPath,
  getPackagedRuntimeEntrypoint,
  getResourcesFolder,
} from "../shared/runtime-layout";

const DEFAULT_PORT = 3927;
const DEFAULT_CONTROL_PORT = 3928;
const HEALTH_PATH = "/api/health";
const CONTROL_PATH = "/__gno_shell/control";
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 300;
const APP_WINDOW_TITLE = "GNO Desktop Beta";
const SELFTEST_FLAG = "1";

type WindowHandle = {
  show(): void;
  focus(): void;
  webview: {
    loadURL(url: string): void;
  };
};

let mainWindow: WindowHandle | null = null;
let serverProcess: Bun.Subprocess | null = null;
let controlServer: Bun.Server<undefined> | null = null;

interface ServeRuntimeTarget {
  bunBinary: string;
  cwd: string;
  entrypoint: string;
  source: "packaged" | "repo";
}

function resolveServeRuntime(
  repoRoot: string,
  runtimeFolder: string
): ServeRuntimeTarget {
  const resourcesFolder = getResourcesFolder();
  const packagedEntrypoint = getPackagedRuntimeEntrypoint(
    resourcesFolder,
    runtimeFolder
  );
  const packagedBun = getBundledBunPath();

  if (existsSync(packagedEntrypoint) && existsSync(packagedBun)) {
    return {
      bunBinary: packagedBun,
      cwd: join(resourcesFolder, "app", runtimeFolder),
      entrypoint: packagedEntrypoint,
      source: "packaged",
    };
  }

  return {
    bunBinary: "bun",
    cwd: repoRoot,
    entrypoint: join(repoRoot, "src/index.ts"),
    source: "repo",
  };
}

function getServeCommand(target: ServeRuntimeTarget, port: number): string[] {
  return [target.bunBinary, target.entrypoint, "serve", "--port", String(port)];
}

function getBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function normalizeRoute(route: string): string {
  return route.startsWith("/") ? route : `/${route}`;
}

function toHttpUrl(input: string, baseUrl: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }

  const parsed = new URL(input);
  const routeFromQuery = parsed.searchParams.get("route");
  if (routeFromQuery) {
    return new URL(normalizeRoute(routeFromQuery), baseUrl).toString();
  }

  return baseUrl;
}

function navigateMainWindow(target: string, baseUrl: string): void {
  if (!mainWindow) {
    return;
  }
  mainWindow.webview.loadURL(toHttpUrl(target, baseUrl));
  mainWindow.show();
  mainWindow.focus();
}

async function waitForServerReady(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "server did not answer";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}${HEALTH_PATH}`);
      if (response.ok) {
        return;
      }
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(HEALTH_POLL_MS);
  }

  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function startServer(target: ServeRuntimeTarget, port: number): Bun.Subprocess {
  return Bun.spawn({
    cmd: getServeCommand(target, port),
    cwd: target.cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  });
}

function createWindow(url: string): WindowHandle {
  return new BrowserWindow({
    title: APP_WINDOW_TITLE,
    url,
    frame: {
      width: 1440,
      height: 960,
      x: 140,
      y: 80,
    },
  });
}

function startControlServer(
  baseUrl: string,
  controlPort: number
): Bun.Server<undefined> {
  return Bun.serve({
    port: controlPort,
    hostname: "127.0.0.1",
    routes: {
      [CONTROL_PATH]: {
        POST: async (request: Request) => {
          let action = "focus";
          let target: string | null = null;

          try {
            const body = (await request.json()) as {
              action?: string;
              target?: string;
            };
            action = body.action ?? action;
            target = body.target ?? null;
          } catch {
            // Focus fallback.
          }

          if (action === "open-url" && target) {
            navigateMainWindow(target, baseUrl);
          } else {
            mainWindow?.show();
            mainWindow?.focus();
          }

          return Response.json({ ok: true });
        },
      },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
  });
}

async function handOffToExistingInstance(controlUrl: string): Promise<boolean> {
  try {
    const response = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "focus" }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function installMenu(baseUrl: string): void {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [{ label: "Quit", role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "GNO",
      submenu: [
        {
          label: "Open Search",
          action: "open-search",
          accelerator: "l",
        },
        {
          label: "Open Collections",
          action: "open-collections",
          accelerator: "k",
        },
      ],
    },
  ]);

  Electrobun.events.on(
    "application-menu-clicked",
    (event: { data?: { action?: string } }) => {
      const action = String(event.data?.action ?? "");
      if (action === "open-search") {
        navigateMainWindow("gno://open?route=/search", baseUrl);
        return;
      }
      if (action === "open-collections") {
        navigateMainWindow("gno://open?route=/collections", baseUrl);
      }
    }
  );

  Electrobun.events.on("open-url", (event: { data: { url: string } }) => {
    navigateMainWindow(event.data.url, baseUrl);
  });
}

function installShortcuts(baseUrl: string): void {
  const shortcuts = [
    ["CommandOrControl+Shift+L", "gno://open?route=/search"],
    ["CommandOrControl+Shift+K", "gno://open?route=/collections"],
  ] as const;

  for (const [shortcut, url] of shortcuts) {
    GlobalShortcut.register(shortcut, () => {
      navigateMainWindow(url, baseUrl);
    });
  }
}

function getRuntimeConfig(
  config: Awaited<ReturnType<typeof BuildConfig.get>>
): {
  repoRoot: string;
  runtimeFolder: string;
  port: number;
  baseUrl: string;
  controlPort: number;
  controlUrl: string;
} {
  const runtime = config.runtime as
    | {
        gnoRepoRoot?: string;
        gnoRuntimeFolder?: string;
        gnoServePort?: number | string;
        gnoControlPort?: number | string;
      }
    | undefined;
  const repoRoot = runtime?.gnoRepoRoot ?? resolve(import.meta.dir, "../../..");
  const port = Number(
    process.env.GNO_ELECTROBUN_PORT ?? runtime?.gnoServePort ?? DEFAULT_PORT
  );
  const controlPort = Number(
    process.env.GNO_ELECTROBUN_CONTROL_PORT ??
      runtime?.gnoControlPort ??
      DEFAULT_CONTROL_PORT
  );

  return {
    repoRoot,
    runtimeFolder: runtime?.gnoRuntimeFolder ?? DEFAULT_GNO_RUNTIME_FOLDER,
    port,
    baseUrl: getBaseUrl(port),
    controlPort,
    controlUrl: `http://127.0.0.1:${controlPort}${CONTROL_PATH}`,
  };
}

async function shutdown(): Promise<void> {
  if (controlServer) {
    void controlServer.stop(true);
  }
  serverProcess?.kill();
}

async function main(): Promise<void> {
  const config = await BuildConfig.get();
  const { repoRoot, runtimeFolder, port, baseUrl, controlPort, controlUrl } =
    getRuntimeConfig(config);
  const serveRuntime = resolveServeRuntime(repoRoot, runtimeFolder);

  if (await handOffToExistingInstance(controlUrl)) {
    process.exit(0);
  }

  controlServer = startControlServer(baseUrl, controlPort);
  installMenu(baseUrl);
  installShortcuts(baseUrl);
  console.log(
    `[gno-electrobun-shell] launching GNO runtime from ${serveRuntime.source}`
  );
  serverProcess = startServer(serveRuntime, port);
  await waitForServerReady(baseUrl);
  if (process.env.GNO_ELECTROBUN_SELFTEST === SELFTEST_FLAG) {
    const response = await fetch(`${baseUrl}/api/status`);
    if (!response.ok) {
      throw new Error(`self-test status probe failed: ${response.status}`);
    }
    await shutdown();
    Utils.quit();
    return;
  }
  mainWindow = createWindow(baseUrl);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

void main().catch(async (error) => {
  console.error(
    "[gno-electrobun-shell] startup failed:",
    error instanceof Error ? error.message : String(error)
  );
  await shutdown();
});
