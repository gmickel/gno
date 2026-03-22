// node:fs/promises stat/statfs: no Bun API for directory inspection or filesystem capacity
import { stat, statfs } from "node:fs/promises";
// node:os homedir: no Bun equivalent
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { IndexStatus } from "../store/types";
import type {
  AppStatusResponse,
  HealthCenterState,
  HealthCheck,
  SuggestedCollection,
} from "./status-model";

import { getModelsCachePath } from "../app/constants";
import { ModelCache } from "../llm/cache";
import { envIsSet, resolveDownloadPolicy } from "../llm/policy";
import { getActivePreset } from "../llm/registry";
import { downloadState, type ServerContext } from "./context";

const GIGABYTE = 1024 * 1024 * 1024;
const DISK_WARN_BYTES = 4 * GIGABYTE;
const DISK_ERROR_BYTES = 2 * GIGABYTE;
const SIZE_REGEX = /~[\d.]+GB/;
const SUGGESTED_FOLDERS = [
  {
    label: "Documents",
    suffix: "Documents",
    reason: "Good default for notes and docs",
  },
  {
    label: "Desktop",
    suffix: "Desktop",
    reason: "Useful for quick tests and imports",
  },
  {
    label: "Downloads",
    suffix: "Downloads",
    reason: "Good for PDFs and imports",
  },
  {
    label: "Obsidian",
    suffix: "Documents/Obsidian",
    reason: "Common Obsidian vault path",
  },
  {
    label: "Obsidian Vault",
    suffix: "Documents/Obsidian Vault",
    reason: "Another common Obsidian vault path",
  },
] as const;

interface DiskSnapshot {
  freeBytes: number;
  totalBytes: number;
  path: string;
}

export interface StatusBuildDeps {
  inspectDisk?: (path: string) => Promise<DiskSnapshot | null>;
  isModelCached?: (uri: string) => Promise<boolean>;
  listSuggestedCollections?: () => Promise<SuggestedCollection[]>;
}

function formatBytes(bytes: number): string {
  if (bytes >= GIGABYTE) {
    return `${(bytes / GIGABYTE).toFixed(1)} GB`;
  }
  const megabyte = 1024 * 1024;
  if (bytes >= megabyte) {
    return `${Math.round(bytes / megabyte)} MB`;
  }
  return `${bytes} B`;
}

function summarizeCount(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function toDisplayPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function extractEstimatedFootprint(name: string): string | null {
  const match = name.match(SIZE_REGEX);
  return match ? match[0] : null;
}

function resolvePolicySource(
  env: Record<string, string | undefined>
): AppStatusResponse["bootstrap"]["policy"]["source"] {
  if (envIsSet(env, "HF_HUB_OFFLINE")) {
    return "hf-hub-offline";
  }
  if (envIsSet(env, "GNO_OFFLINE")) {
    return "gno-offline";
  }
  if (envIsSet(env, "GNO_NO_AUTO_DOWNLOAD")) {
    return "no-auto-download";
  }
  return "default";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findInspectablePath(path: string): Promise<string | null> {
  let current = path;
  while (true) {
    if (await pathExists(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function inspectDisk(path: string): Promise<DiskSnapshot | null> {
  const target = await findInspectablePath(path);
  if (!target) {
    return null;
  }

  try {
    const snapshot = await statfs(target);
    const freeBytes = Number(snapshot.bavail) * Number(snapshot.bsize);
    const totalBytes = Number(snapshot.blocks) * Number(snapshot.bsize);
    return {
      freeBytes,
      totalBytes,
      path: target,
    };
  } catch {
    return null;
  }
}

async function listSuggestedCollections(): Promise<SuggestedCollection[]> {
  const home = homedir();
  const suggestions: SuggestedCollection[] = [];

  for (const candidate of SUGGESTED_FOLDERS) {
    const path = join(home, candidate.suffix);
    if (await pathExists(path)) {
      suggestions.push({
        label: candidate.label,
        path,
        reason: candidate.reason,
      });
    }
  }

  return suggestions.slice(0, 4);
}

function getCheckState(checks: HealthCheck[]): HealthCenterState["state"] {
  const hasError = checks.some((check) => check.status === "error");
  const hasWarn = checks.some((check) => check.status === "warn");
  const needsSetup =
    checks.find((check) => check.id === "collections")?.status !== "ok";

  if (needsSetup) {
    return "setup-required";
  }
  if (hasError || hasWarn) {
    return "needs-attention";
  }
  return "healthy";
}

function buildBackgroundCheck(
  ctx: ServerContext,
  status: IndexStatus
): HealthCheck | null {
  const watchState = ctx.watchService?.getState();
  if (!watchState || status.collections.length === 0) {
    return null;
  }

  if (watchState.failedCollections.length > 0) {
    return {
      id: "background",
      title: "Background service",
      status: "warn",
      summary: `${summarizeCount(watchState.failedCollections.length, "watcher")} failed to start`,
      detail:
        "Some folders are not being watched live. Manual sync still works, but automatic refresh may be incomplete until the watcher recovers.",
    };
  }

  if (
    watchState.syncingCollections.length > 0 ||
    watchState.queuedCollections.length > 0
  ) {
    return {
      id: "background",
      title: "Background service",
      status: "warn",
      summary: "Watcher activity is still being processed",
      detail:
        "Recent file changes are queued or syncing. The workspace should catch up automatically without a restart.",
    };
  }

  return {
    id: "background",
    title: "Background service",
    status: "ok",
    summary: `${summarizeCount(watchState.activeCollections.length, "folder")} watched live`,
    detail: watchState.lastEventAt
      ? `Last file event: ${watchState.lastEventAt}.`
      : "Live watching is armed and waiting for file changes.",
  };
}

function buildCollectionCheck(status: IndexStatus): HealthCheck {
  if (status.collections.length === 0) {
    return {
      id: "collections",
      title: "Folders",
      status: "warn",
      summary: "No folders connected yet",
      detail:
        "Add at least one folder so GNO has something to index and search.",
      actionLabel: "Add folder",
      actionKind: "add-collection",
    };
  }

  return {
    id: "collections",
    title: "Folders",
    status: "ok",
    summary: `${summarizeCount(status.collections.length, "folder")} connected`,
    detail: `${summarizeCount(status.activeDocuments, "document")} active across your current sources.`,
    actionLabel: "Manage folders",
    actionKind: "open-collections",
  };
}

function buildIndexingCheck(status: IndexStatus): HealthCheck {
  if (status.recentErrors > 0) {
    return {
      id: "indexing",
      title: "Indexing",
      status: "error",
      summary: `${summarizeCount(status.recentErrors, "recent error")} need attention`,
      detail:
        "GNO saw ingest failures in the last 24 hours. Re-run indexing after fixing the affected files or folder settings.",
      actionLabel: "Run update",
      actionKind: "sync",
    };
  }

  if (status.collections.length > 0 && status.activeDocuments === 0) {
    return {
      id: "indexing",
      title: "Indexing",
      status: "warn",
      summary: "Folders connected, but nothing is indexed yet",
      detail:
        "Start a sync to scan your folders and build the first searchable index.",
      actionLabel: "Run update",
      actionKind: "sync",
    };
  }

  if (status.embeddingBacklog > 0) {
    return {
      id: "indexing",
      title: "Indexing",
      status: "warn",
      summary: `${summarizeCount(status.embeddingBacklog, "chunk")} still waiting on embeddings`,
      detail:
        "Search works, but semantic and answer features will improve once embeddings finish.",
      actionLabel: "Run update",
      actionKind: "sync",
    };
  }

  return {
    id: "indexing",
    title: "Indexing",
    status: "ok",
    summary:
      status.activeDocuments > 0
        ? `${summarizeCount(status.activeDocuments, "document")} indexed`
        : "Ready for your first sync",
    detail:
      status.lastUpdatedAt !== null
        ? `Last update: ${status.lastUpdatedAt}.`
        : "No indexing runs recorded yet.",
    actionLabel: "Run update",
    actionKind: "sync",
  };
}

async function buildModelCheck(
  ctx: ServerContext,
  deps: StatusBuildDeps
): Promise<HealthCheck> {
  const preset = getActivePreset(ctx.config);
  const cache = new ModelCache(getModelsCachePath());
  const isModelCached =
    deps.isModelCached ?? ((uri: string) => cache.isCached(uri));

  const [embedCached, rerankCached, genCached] = await Promise.all([
    isModelCached(preset.embed),
    isModelCached(preset.rerank),
    isModelCached(preset.gen),
  ]);

  if (downloadState.active) {
    return {
      id: "models",
      title: "Models",
      status: "warn",
      summary: "Model download in progress",
      detail:
        "GNO is pulling the active preset now. Leave this page open until downloads finish.",
      actionLabel: "Download models",
      actionKind: "download-models",
    };
  }

  if (!embedCached) {
    return {
      id: "models",
      title: "Models",
      status: "error",
      summary: `${preset.name} still needs core local models`,
      detail:
        "Download the active preset so semantic search and indexing embeddings can run locally.",
      actionLabel: "Download models",
      actionKind: "download-models",
    };
  }

  if (!rerankCached || !genCached) {
    const missing = [
      !rerankCached ? "rerank" : null,
      !genCached ? "answer" : null,
    ].filter(Boolean);

    return {
      id: "models",
      title: "Models",
      status: "warn",
      summary: `${preset.name} is usable, but ${missing.join(" + ")} models are still missing`,
      detail:
        "Core search is ready. Download the rest of the preset for best ranking and local AI answers.",
      actionLabel: "Download models",
      actionKind: "download-models",
    };
  }

  return {
    id: "models",
    title: "Models",
    status: "ok",
    summary: `${preset.name} is ready`,
    detail: ctx.capabilities.answer
      ? "Search, reranking, and local answers are available."
      : "Search models are ready. Answer generation is currently unavailable.",
    actionLabel: "Download models",
    actionKind: "download-models",
  };
}

async function buildDiskCheck(
  status: IndexStatus,
  deps: StatusBuildDeps
): Promise<HealthCheck> {
  const snapshot =
    (await deps.inspectDisk?.(getModelsCachePath())) ??
    (await inspectDisk(getModelsCachePath()));

  if (!snapshot) {
    return {
      id: "disk",
      title: "Disk",
      status: "warn",
      summary: "Disk space could not be inspected",
      detail: `GNO could not read filesystem capacity near ${toDisplayPath(getModelsCachePath())}.`,
    };
  }

  const summary = `${formatBytes(snapshot.freeBytes)} free near ${toDisplayPath(snapshot.path)}`;

  if (snapshot.freeBytes < DISK_ERROR_BYTES) {
    return {
      id: "disk",
      title: "Disk",
      status: "error",
      summary,
      detail:
        "Local models and future indexes need more room. Free at least 2-4 GB before continuing.",
    };
  }

  if (snapshot.freeBytes < DISK_WARN_BYTES) {
    return {
      id: "disk",
      title: "Disk",
      status: "warn",
      summary,
      detail:
        status.collections.length === 0
          ? "You can keep going, but model downloads may fail if space gets tighter."
          : "Search works now, but future model downloads or large syncs may hit storage limits.",
    };
  }

  return {
    id: "disk",
    title: "Disk",
    status: "ok",
    summary,
    detail:
      "Enough headroom for the active local models and routine indexing work.",
  };
}

async function buildBootstrapState(
  ctx: ServerContext
): Promise<AppStatusResponse["bootstrap"]> {
  const preset = getActivePreset(ctx.config);
  const cache = new ModelCache(getModelsCachePath());
  const entries = await cache.list();
  const policy = resolveDownloadPolicy(process.env, {});
  const policySource = resolvePolicySource(process.env);
  const roleUris = [
    { role: "embed" as const, uri: preset.embed },
    { role: "rerank" as const, uri: preset.rerank },
    { role: "expand" as const, uri: preset.expand ?? preset.gen },
    { role: "gen" as const, uri: preset.gen },
  ];

  const modelEntries = await Promise.all(
    roleUris.map(async ({ role, uri }) => {
      const path = await cache.getCachedPath(uri);
      const entry = entries.find((candidate) => candidate.uri === uri);
      return {
        role,
        uri,
        cached: path !== null,
        path,
        sizeBytes: entry?.size ?? null,
        statusLabel: path !== null ? "Ready" : "Needs download",
      };
    })
  );

  const cachedCount = modelEntries.filter((entry) => entry.cached).length;
  const totalCount = modelEntries.length;

  const policySummary = policy.offline
    ? "Offline mode. Cached models only."
    : policy.allowDownload
      ? "Models can auto-download on first use."
      : "Manual model download only. Auto-download is disabled.";

  return {
    runtime: {
      kind: "bun",
      strategy: "manual-install-beta",
      currentVersion: Bun.version,
      requiredVersion: ">=1.3.0",
      ready: true,
      managedByApp: false,
      summary: `This beta runs on Bun ${Bun.version}.`,
      detail:
        "Current beta installs still expect Bun to be present on the machine. Final desktop packaging work is separate.",
    },
    policy: {
      offline: policy.offline,
      allowDownload: policy.allowDownload,
      source: policySource,
      summary: policySummary,
    },
    cache: {
      path: cache.dir,
      totalSizeBytes: await cache.totalSize(),
      totalSizeLabel: formatBytes(await cache.totalSize()),
    },
    models: {
      activePresetId: preset.id,
      activePresetName: preset.name,
      estimatedFootprint: extractEstimatedFootprint(preset.name),
      downloading: downloadState.active,
      cachedCount,
      totalCount,
      summary:
        cachedCount === totalCount
          ? `${preset.name} is fully cached.`
          : `${cachedCount}/${totalCount} preset roles are cached for ${preset.name}.`,
      entries: modelEntries,
    },
  };
}

function buildOnboarding(
  status: IndexStatus,
  modelCheck: HealthCheck,
  suggestions: SuggestedCollection[],
  presetName: string
): AppStatusResponse["onboarding"] {
  const foldersReady = status.collections.length > 0;
  const modelsReady = modelCheck.status === "ok";
  const indexedReady =
    status.activeDocuments > 0 && status.embeddingBacklog === 0;

  const steps = [
    {
      id: "folders",
      title: "Pick folders",
      status: foldersReady ? "complete" : "current",
      detail: foldersReady
        ? `${summarizeCount(status.collections.length, "folder")} connected.`
        : "Choose the folders you want GNO to watch and index.",
    },
    {
      id: "preset",
      title: "Choose speed vs quality",
      status: "complete",
      detail: `Current preset: ${presetName}. You can change this any time.`,
    },
    {
      id: "models",
      title: "Prepare local models",
      status: modelsReady ? "complete" : foldersReady ? "current" : "upcoming",
      detail: modelCheck.detail,
    },
    {
      id: "indexing",
      title: "Finish first index",
      status: indexedReady ? "complete" : foldersReady ? "current" : "upcoming",
      detail:
        status.activeDocuments > 0
          ? `${summarizeCount(status.activeDocuments, "document")} indexed so far.`
          : "Run the first sync to scan your folders and build the search index.",
    },
  ] satisfies AppStatusResponse["onboarding"]["steps"];

  if (!foldersReady) {
    return {
      ready: false,
      stage: "add-collection",
      headline: "Start by connecting the folders you care about",
      detail:
        "Pick notes, docs, or a project directory. GNO will scan them and build search automatically.",
      suggestedCollections: suggestions,
      steps,
    };
  }

  if (!modelsReady) {
    return {
      ready: false,
      stage: "models",
      headline: "Your folders are connected. Finish model setup next",
      detail: modelCheck.detail,
      suggestedCollections: suggestions,
      steps,
    };
  }

  if (!indexedReady) {
    return {
      ready: false,
      stage: "indexing",
      headline: "GNO is almost ready. Finish the first indexing run",
      detail:
        status.activeDocuments > 0
          ? "The first sync started. Let embeddings finish so semantic search and answers can fully light up."
          : "Run the first sync to populate the index from the folders you connected.",
      suggestedCollections: suggestions,
      steps,
    };
  }

  return {
    ready: true,
    stage: "ready",
    headline: "Workspace ready",
    detail: "Your folders, local models, and first index are all in place.",
    suggestedCollections: suggestions,
    steps,
  };
}

export async function buildAppStatus(
  ctx: ServerContext,
  deps: StatusBuildDeps = {}
): Promise<AppStatusResponse> {
  const result = await ctx.store.getStatus();
  if (!result.ok) {
    throw result.error;
  }

  const status = result.value;
  const preset = getActivePreset(ctx.config);
  const [modelCheck, diskCheck, suggestions, bootstrap] = await Promise.all([
    buildModelCheck(ctx, deps),
    buildDiskCheck(status, deps),
    deps.listSuggestedCollections?.() ?? listSuggestedCollections(),
    buildBootstrapState(ctx),
  ]);

  const backgroundCheck = buildBackgroundCheck(ctx, status);
  const checks = [
    buildCollectionCheck(status),
    buildIndexingCheck(status),
    modelCheck,
    diskCheck,
    backgroundCheck,
  ].filter((check): check is HealthCheck => check !== null);

  const embedState = ctx.scheduler?.getState();
  const watchState = ctx.watchService?.getState();
  const eventState = ctx.eventBus?.getState();

  const healthState = getCheckState(checks);
  const healthSummary =
    healthState === "healthy"
      ? "Folders, local models, and disk all look ready."
      : healthState === "setup-required"
        ? "Finish first-run setup to make GNO useful without touching the terminal."
        : "GNO works, but a few issues still need attention before it feels reliable.";

  return {
    indexName: status.indexName,
    configPath: status.configPath,
    dbPath: status.dbPath,
    collections: status.collections.map((collection) => ({
      name: collection.name,
      path: collection.path,
      documentCount: collection.activeDocuments,
      chunkCount: collection.totalChunks,
      embeddedCount: collection.embeddedChunks,
    })),
    totalDocuments: status.activeDocuments,
    totalChunks: status.totalChunks,
    embeddingBacklog: status.embeddingBacklog,
    lastUpdated: status.lastUpdatedAt,
    recentErrors: status.recentErrors,
    healthy: checks.every((check) => check.status === "ok"),
    activePreset: {
      id: preset.id,
      name: preset.name,
    },
    capabilities: ctx.capabilities,
    onboarding: buildOnboarding(status, modelCheck, suggestions, preset.name),
    health: {
      state: healthState,
      summary: healthSummary,
      checks,
    },
    background: {
      watcher: {
        expectedCollections: watchState?.expectedCollections ?? [],
        activeCollections: watchState?.activeCollections ?? [],
        failedCollections: watchState?.failedCollections ?? [],
        queuedCollections: watchState?.queuedCollections ?? [],
        syncingCollections: watchState?.syncingCollections ?? [],
        lastEventAt: watchState?.lastEventAt ?? null,
        lastSyncAt: watchState?.lastSyncAt ?? null,
      },
      embedding: {
        available: ctx.scheduler != null,
        pendingDocCount: embedState?.pendingDocCount ?? 0,
        running: embedState?.running ?? false,
        nextRunAt: embedState?.nextRunAt ?? null,
        lastRunAt: embedState?.lastRunAt ?? null,
        lastResult: embedState?.lastResult ?? null,
      },
      events: {
        connectedClients: eventState?.connectedClients ?? 0,
        retryMs: eventState?.retryMs ?? 0,
      },
    },
    bootstrap,
  };
}
