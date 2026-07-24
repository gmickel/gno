import type { BrowserContext, BrowserType, Page, Response } from "playwright";

// node:fs/promises is required for filesystem structure and temp-directory ops.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os is required because Bun has no temp-directory helper.
import { tmpdir } from "node:os";
// node:path is required because Bun has no path utilities.
import { join } from "node:path";

import { saveConfigToPath } from "../../src/config/saver";

export interface RecordedResponse {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  requestBody: unknown;
  responseHeaders: Record<string, string>;
  status: number;
  url: string;
}

interface FixtureServer {
  baseUrl: string;
  canaryRequests: string[];
  stop(): void;
}

export interface ClipperE2EHarness {
  baseUrl: string;
  collectionDir: string;
  configPath: string;
  extensionDir: string;
  fixture: FixtureServer;
  indexName: string;
  port: number;
  records: RecordedResponse[];
  root: string;
  startResident(): Promise<void>;
  stopResident(): Promise<void>;
}

const reservePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) throw new Error("Bun did not reserve a port");
  return port;
};

const parseJson = (value: string | null): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const fixtureHtml = (baseUrl: string): string => `<!doctype html>
<html>
  <head>
    <title>Adversarial Visible Article</title>
    <meta name="author" content="Visible Author">
    <meta property="og:site_name" content="Fixture Journal">
    <meta property="article:published_time" content="2026-07-24T08:00:00Z">
    <link rel="canonical" href="${baseUrl}/canonical-never-fetched">
    <style>
      .display-none { display: none; }
      .transparent { opacity: 0; }
    </style>
  </head>
  <body>
    <nav>NAV_SECRET_MUST_NOT_CROSS</nav>
    <main>
      <article>
        <h1>Visible article heading</h1>
        <p id="selection">Exact rendered selection — Zürich 日本語.</p>
        <p>Reader paragraph with <a href="${baseUrl}/link-never-fetched">safe link</a>.</p>
        <blockquote>Visible quoted evidence.</blockquote>
        <ol><li>First visible item</li><li>Second visible item</li></ol>
        <pre><code class="language-ts">const visible = true;</code></pre>
        <hr>
        <p hidden>HIDDEN_ATTRIBUTE_SECRET</p>
        <p inert>INERT_SECRET</p>
        <p aria-hidden="true">ARIA_SECRET</p>
        <p class="display-none">DISPLAY_NONE_SECRET</p>
        <p class="transparent">OPACITY_SECRET</p>
        <p><a href="javascript:alert('no')">DANGEROUS_LINK_TEXT</a></p>
        <img alt="IMAGE_SECRET" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
        <svg><text>SVG_SECRET</text></svg>
        <math><mtext>MATHML_SECRET</mtext></math>
        <iframe srcdoc="<p>IFRAME_SECRET</p>"></iframe>
        <canvas>CANVAS_SECRET</canvas>
      </article>
    </main>
    <aside>ASIDE_SECRET_MUST_NOT_CROSS</aside>
    <form>FORM_SECRET_MUST_NOT_CROSS</form>
    <script>
      history.replaceState({ fixture: true }, "", location.href);
      window.selectFixturePassage = () => {
        const node = document.querySelector("#selection").firstChild;
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };
    </script>
  </body>
</html>`;

const startFixtureServer = (): FixtureServer => {
  const canaryRequests: string[] = [];
  let baseUrl = "";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/fixture") {
        return new Response(fixtureHtml(baseUrl), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/favicon.ico")
        return new Response(null, { status: 204 });
      canaryRequests.push(pathname);
      return new Response("remote-fetch canary", { status: 418 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl,
    canaryRequests,
    stop: () => server.stop(true),
  };
};

const waitForHealthy = async (
  baseUrl: string,
  process: ReturnType<typeof Bun.spawn>
): Promise<void> => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`gno serve exited early with ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Resident still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
};

const readPipeText = async (pipe: unknown): Promise<string> => {
  if (!(pipe instanceof ReadableStream)) return "";
  return (await new Response(pipe).text()).trim();
};

const processOutput = async (
  process: ReturnType<typeof Bun.spawn>
): Promise<string> => {
  const [stdout, stderr] = await Promise.all([
    readPipeText(process.stdout),
    readPipeText(process.stderr),
  ]);
  return `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`;
};

const waitForResidentRelease = async (baseUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(200),
      });
    } catch {
      // Give the Linux listener teardown one additional scheduling turn before
      // the same fixed port is rebound by the recovery test.
      await Bun.sleep(100);
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`gno serve listener remained reachable at ${baseUrl}`);
};

export const createClipperE2EHarness = async (): Promise<ClipperE2EHarness> => {
  const root = await mkdtemp(join(tmpdir(), "gno-clipper-e2e-"));
  const configDir = join(root, "config");
  const collectionDir = join(root, "collection");
  const configPath = join(configDir, "index.yml");
  const port = reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const indexName = "clipper-e2e";
  const fixture = startFixtureServer();
  const records: RecordedResponse[] = [];
  let resident: ReturnType<typeof Bun.spawn> | null = null;

  await mkdir(collectionDir, { recursive: true });
  const saveResult = await saveConfigToPath(
    {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "notes",
          path: collectionDir,
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    },
    configPath
  );
  if (!saveResult.ok) throw new Error(saveResult.error.message);

  const startResident = async (): Promise<void> => {
    if (resident !== null) throw new Error("Resident is already running");
    const failures: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const candidate = Bun.spawn(
        [
          process.execPath,
          "src/index.ts",
          "--config",
          configPath,
          "--index",
          indexName,
          "serve",
          "--port",
          String(port),
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GNO_CACHE_DIR: join(root, "cache"),
            GNO_CONFIG_DIR: configDir,
            GNO_DATA_DIR: join(root, "data"),
            GNO_OFFLINE: "1",
            NODE_ENV: "production",
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      resident = candidate;
      try {
        await waitForHealthy(baseUrl, candidate);
        return;
      } catch (error) {
        if (candidate.exitCode === null) candidate.kill();
        await candidate.exited;
        failures.push(
          `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)} ${await processOutput(candidate)}`
        );
        resident = null;
        if (attempt < 3) await Bun.sleep(attempt * 250);
      }
    }
    throw new Error(`gno serve failed to start: ${failures.join("; ")}`);
  };

  const stopResident = async (): Promise<void> => {
    if (resident === null) return;
    const running = resident;
    running.kill();
    await running.exited;
    await processOutput(running);
    resident = null;
    await waitForResidentRelease(baseUrl);
  };

  return {
    baseUrl,
    collectionDir,
    configPath,
    extensionDir: join(process.cwd(), "browser-extension", "dist"),
    fixture,
    indexName,
    port,
    records,
    root,
    startResident,
    stopResident,
  };
};

export const launchExtensionContext = async (
  chromium: BrowserType,
  profileDir: string,
  extensionDir: string
): Promise<BrowserContext> => {
  const options: Parameters<BrowserType["launchPersistentContext"]>[1] = {
    channel: "chromium",
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { height: 900, width: 1280 },
  };
  return chromium.launchPersistentContext(profileDir, {
    ...options,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
};

export const grantExtensionLocalNetworkAccess = async (
  context: BrowserContext
): Promise<void> => {
  // Chromium refuses an origin-scoped automation grant for the extension's
  // opaque chrome-extension:// origin. This profile is temporary and isolated;
  // the wire assertions below still prove the server accepts only the exact
  // extension origin.
  await context.grantPermissions(["local-network-access"]);
};

export const extensionIdFromWorker = async (
  context: BrowserContext
): Promise<string> => {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  return new URL(worker.url()).hostname;
};

export const recordClipperWire = (
  context: BrowserContext,
  baseUrl: string,
  records: RecordedResponse[]
): void => {
  context.on("response", (response: Response) => {
    if (!response.url().startsWith(baseUrl)) return;
    const request = response.request();
    void (async () => {
      const contentType = response.headers()["content-type"] ?? "";
      records.push({
        body: contentType.includes("application/json")
          ? await response.json()
          : null,
        headers: await request.allHeaders(),
        method: request.method(),
        requestBody: parseJson(request.postData()),
        responseHeaders: await response.allHeaders(),
        status: response.status(),
        url: response.url(),
      });
    })().catch(() => undefined);
  });
};

export const activateFixtureSelection = async (page: Page): Promise<void> => {
  await page.bringToFront();
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        selectFixturePassage(): void;
      }
    ).selectFixturePassage();
  });
};
