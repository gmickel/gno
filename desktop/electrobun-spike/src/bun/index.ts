import Electrobun, {
  ApplicationMenu,
  BuildConfig,
  BrowserWindow,
  GlobalShortcut,
  Utils,
} from "electrobun/bun";
// node:fs/promises appendFile has no Bun equivalent for atomic append.
import { appendFile } from "node:fs/promises";
// node:path has no Bun equivalent.
import { join, resolve } from "node:path";

const DEFAULT_PORT = 3927;
const DEFAULT_CONTROL_PORT = 3928;
const HEALTH_PATH = "/api/health";
const CONTROL_PATH = "/__electrobun_spike/control";
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 300;
const WINDOW_BOUNDS = {
  width: 1440,
  height: 960,
  x: 140,
  y: 80,
} as const;

let mainWindow: BrowserWindow | null = null;
let serverProcess: Bun.Subprocess | null = null;
let controlServer: Bun.Server<undefined> | null = null;

function log(message: string): void {
  console.log(`[electrobun-spike] ${message}`);
}

function getEventLogPath(): string {
  return join(Utils.paths.userCache, "gno-electrobun-spike-events.log");
}

async function recordEvent(name: string, detail?: string): Promise<void> {
  const path = getEventLogPath();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    name,
    detail: detail ?? null,
  });
  await appendFile(path, `${line}\n`, "utf8");
  log(`${name}${detail ? `: ${detail}` : ""}`);
}

function getGnoServeCommand(repoRoot: string, port: number): string[] {
  const entrypoint = join(repoRoot, "src/index.ts");
  return ["bun", entrypoint, "serve", "--port", String(port)];
}

function getBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function getRuntimeConfig(
  config: Awaited<ReturnType<typeof BuildConfig.get>>
): {
  repoRoot: string;
  port: number;
  baseUrl: string;
  controlPort: number;
  controlUrl: string;
} {
  const runtime = config.runtime as
    | {
        gnoRepoRoot?: string;
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
    port,
    baseUrl: getBaseUrl(port),
    controlPort,
    controlUrl: `http://127.0.0.1:${controlPort}${CONTROL_PATH}`,
  };
}

function startGnoServer(repoRoot: string, port: number): Bun.Subprocess {
  const cmd = getGnoServeCommand(repoRoot, port);
  log(`starting gno server: ${cmd.join(" ")}`);

  const subprocess = Bun.spawn({
    cmd,
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  });

  void subprocess.exited.then((code) => {
    log(`gno server exited with code ${code}`);
  });

  return subprocess;
}

async function waitForServerReady(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "server did not answer";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}${HEALTH_PATH}`);
      if (response.ok) {
        log(`gno server healthy at ${url}`);
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

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    title: "GNO Desktop Beta",
    url,
    frame: WINDOW_BOUNDS,
  });

  window.webview.on("did-navigate", (event) => {
    const navEvent = event as { data?: { detail?: string } };
    log(`navigated to ${String(navEvent.data?.detail ?? "")}`);
  });
  return window;
}

function normalizeRoute(route: string): string {
  if (route.startsWith("/")) {
    return route;
  }
  return `/${route}`;
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

  switch (parsed.hostname) {
    case "search": {
      const q = parsed.searchParams.get("q") ?? "";
      return new URL(`/search?q=${encodeURIComponent(q)}`, baseUrl).toString();
    }
    case "collections":
      return new URL("/collections", baseUrl).toString();
    default:
      return baseUrl;
  }
}

function navigateMainWindow(target: string, baseUrl: string): void {
  if (!mainWindow) {
    return;
  }

  const nextUrl = toHttpUrl(target, baseUrl);
  void recordEvent("navigate", nextUrl);
  mainWindow.webview.loadURL(nextUrl);
  mainWindow.show();
  mainWindow.focus();
}

async function chooseFolder(repoRoot: string): Promise<void> {
  await recordEvent("choose-folder:open-dialog");
  const chosen = await Utils.openFileDialog({
    startingFolder: repoRoot,
    allowedFileTypes: "*",
    canChooseFiles: false,
    canChooseDirectory: true,
    allowsMultipleSelection: false,
  });

  const path = chosen[0];
  if (!path) {
    await recordEvent("choose-folder:cancel");
    return;
  }

  await recordEvent("choose-folder:selected", path);
}

async function trashProbeFile(): Promise<void> {
  const probePath = join(
    Utils.paths.userCache,
    `gno-electrobun-trash-probe-${Date.now()}.txt`
  );
  await Bun.write(probePath, `trash probe ${new Date().toISOString()}\n`);
  await recordEvent("trash-probe:created", probePath);
  Utils.moveToTrash(probePath);
  await recordEvent("trash-probe:moved", probePath);
}

async function onMenuAction(
  action: string,
  repoRoot: string,
  baseUrl: string
): Promise<void> {
  switch (action) {
    case "choose-folder":
      await chooseFolder(repoRoot);
      return;
    case "reveal-repo":
      Utils.showItemInFolder(repoRoot);
      await recordEvent("reveal-repo", repoRoot);
      return;
    case "trash-probe":
      await trashProbeFile();
      return;
    case "open-deep-link":
      navigateMainWindow("gno://open?route=/search?q=workspace", baseUrl);
      return;
    case "open-collections":
      navigateMainWindow("gno://collections", baseUrl);
      return;
    default:
      return;
  }
}

function installMenu(repoRoot: string, baseUrl: string): void {
  ApplicationMenu.setApplicationMenu([
    {
      submenu: [{ label: "Quit", role: "quit" }],
    },
    {
      label: "Spike",
      submenu: [
        {
          label: "Choose Folder...",
          action: "choose-folder",
          accelerator: "o",
        },
        {
          label: "Reveal Repo Root",
          action: "reveal-repo",
          accelerator: "r",
        },
        {
          label: "Trash Probe File",
          action: "trash-probe",
          accelerator: "t",
        },
        {
          label: "Open Sample Deep Link",
          action: "open-deep-link",
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

  Electrobun.events.on("application-menu-clicked", (event) => {
    const action = String(event.data.action ?? "");
    void recordEvent("menu-click", action);
    void onMenuAction(action, repoRoot, baseUrl);
  });

  Electrobun.events.on("open-url", (event: { data: { url: string } }) => {
    void recordEvent("open-url", event.data.url);
    navigateMainWindow(event.data.url, baseUrl);
  });
}

async function onShortcutAction(
  action: string,
  repoRoot: string,
  baseUrl: string
): Promise<void> {
  await recordEvent("shortcut", action);
  await onMenuAction(action, repoRoot, baseUrl);
}

function installShortcuts(repoRoot: string, baseUrl: string): void {
  const shortcuts = [
    ["CommandOrControl+Shift+R", "reveal-repo"],
    ["CommandOrControl+Shift+T", "trash-probe"],
    ["CommandOrControl+Shift+L", "open-deep-link"],
  ] as const;

  for (const [shortcut, action] of shortcuts) {
    const registered = GlobalShortcut.register(shortcut, () => {
      void onShortcutAction(action, repoRoot, baseUrl);
    });
    void recordEvent("shortcut-register", `${shortcut}:${registered}`);
  }
}

async function shutdown(): Promise<void> {
  log("shutting down spike");
  void controlServer?.stop(true);
  serverProcess?.kill();
}

async function runSelfTest(repoRoot: string, baseUrl: string): Promise<void> {
  await recordEvent("selftest:start");
  if (process.env.GNO_ELECTROBUN_SELFTEST_DIALOG === "1") {
    await chooseFolder(repoRoot);
  }
  await trashProbeFile();
  await recordEvent("selftest:manual-reveal-available", repoRoot);
  navigateMainWindow("gno://open?route=/search?q=workspace", baseUrl);
  await recordEvent("selftest:done");
}

async function focusExistingWindow(): Promise<void> {
  if (!mainWindow) {
    await recordEvent("focus-existing-window:missing");
    return;
  }

  mainWindow.show();
  mainWindow.focus();
  await recordEvent("focus-existing-window");
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
            // fall back to focus
          }

          await recordEvent("control-request", `${action}:${target ?? ""}`);

          if (action === "open-url" && target) {
            navigateMainWindow(target, baseUrl);
          } else {
            await focusExistingWindow();
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
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "focus" }),
    });

    if (!response.ok) {
      return false;
    }

    await recordEvent("handoff-to-existing-instance", controlUrl);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = await BuildConfig.get();
  const { repoRoot, port, baseUrl, controlPort, controlUrl } =
    getRuntimeConfig(config);
  await Bun.write(getEventLogPath(), "");
  await recordEvent("startup", baseUrl);

  if (await handOffToExistingInstance(controlUrl)) {
    await recordEvent("startup-exit-after-handoff");
    process.exit(0);
  }

  controlServer = startControlServer(baseUrl, controlPort);
  await recordEvent("control-server", String(controlPort));
  installMenu(repoRoot, baseUrl);
  installShortcuts(repoRoot, baseUrl);
  serverProcess = startGnoServer(repoRoot, port);
  await waitForServerReady(baseUrl);
  mainWindow = createWindow(baseUrl);

  if (process.env.GNO_ELECTROBUN_SELFTEST === "1") {
    setTimeout(() => {
      void runSelfTest(repoRoot, baseUrl);
    }, 1500);
  }
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

void main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`startup failed: ${message}`);
  await Utils.showMessageBox({
    type: "error",
    title: "GNO Desktop Beta failed",
    message,
    buttons: ["Quit"],
    defaultId: 0,
    cancelId: 0,
  });
  await shutdown();
});
