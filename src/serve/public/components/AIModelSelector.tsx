/**
 * AIModelSelector - Vacuum tube display for LLM preset selection.
 *
 * Design: "Tube Display" - Evokes vintage radio tuners and oscilloscope
 * selectors. The current model glows warmly in an amber display window,
 * suggesting analog warmth in a digital interface.
 *
 * Uses Old Gold (secondary) to clearly distinguish from search/primary
 * actions - this controls the active retrieval/answer preset.
 */

import {
  AlertCircle,
  BadgeCheck,
  Check,
  ChevronDown,
  Download,
  Loader2,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AppStatusResponse } from "../../status-model";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

interface Preset {
  id: string;
  name: string;
  embed: string;
  rerank: string;
  expand?: string;
  gen: string;
  active: boolean;
}

interface PresetsResponse {
  presets: Preset[];
  activePreset: string;
  capabilities: Capabilities;
}

interface Capabilities {
  bm25: boolean;
  vector: boolean;
  hybrid: boolean;
  answer: boolean;
}

interface SetPresetResponse {
  success: boolean;
  activePreset: string;
  capabilities: Capabilities;
  embedModelChanged?: boolean;
  note?: string;
}

interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

interface DownloadStatus {
  active: boolean;
  currentType: string | null;
  progress: DownloadProgress | null;
  completed: string[];
  failed: Array<{ type: string; error: string }>;
  startedAt: number | null;
}

const PRESET_EXPLANATIONS: Record<string, string> = {
  slim: "Fastest setup. Lowest disk use.",
  balanced: "Better answers. Good default.",
  quality: "Best local answers. Highest disk use.",
  "slim-tuned": "Fine-tuned retrieval in a compact footprint.",
};
const BUILTIN_PRESET_IDS = new Set([
  "slim-tuned",
  "slim",
  "balanced",
  "quality",
]);

// Extract readable model name from preset name
const SIZE_REGEX = /~[\d.]+GB/;
const MODEL_URI_SEGMENT_RE = /\/([^/#]+?)(?:\.(?:gguf|bin|safetensors))?$/i;

function extractBaseName(name: string): string {
  const [firstPart] = name.split("(");
  return firstPart?.trim() ?? name.trim();
}

function extractSize(name: string): string | null {
  const match = name.match(SIZE_REGEX);
  return match ? match[0] : null;
}

function formatPresetLabel(preset: Preset | undefined): string {
  if (!preset) {
    return "Select";
  }

  if (preset.id === "slim-tuned") {
    return "Slim Tuned";
  }

  return extractBaseName(preset.name);
}

function formatModelRole(uri: string | undefined): string {
  if (!uri) {
    return "Not set";
  }

  const hashModel = uri.split("#")[1]?.trim();
  if (hashModel) {
    return hashModel;
  }

  const matched = uri.match(MODEL_URI_SEGMENT_RE)?.[1];
  return matched?.trim() || uri;
}

export interface AIModelSelectorProps {
  onPresetChange?: (presetId: string) => void;
  showDetails?: boolean;
  showDownloadAction?: boolean;
  showLabel?: boolean;
}

function isCustomPreset(preset: Preset): boolean {
  return !BUILTIN_PRESET_IDS.has(preset.id);
}

export function AIModelSelector({
  onPresetChange,
  showDetails = false,
  showDownloadAction = true,
  showLabel = true,
}: AIModelSelectorProps = {}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelsNeeded, setModelsNeeded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);

  // Download state
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(
    null
  );
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (!triggerRef.current || typeof window === "undefined") {
      return;
    }

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 32);
    const left = Math.max(
      16,
      Math.min(rect.left, window.innerWidth - width - 16)
    );
    const top = rect.bottom + 8;

    setMenuPosition({ left, top, width });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    updateMenuPosition();

    const handlePosition = () => updateMenuPosition();
    window.addEventListener("resize", handlePosition);
    window.addEventListener("scroll", handlePosition, true);
    return () => {
      window.removeEventListener("resize", handlePosition);
      window.removeEventListener("scroll", handlePosition, true);
    };
  }, [open, updateMenuPosition]);

  // Check capabilities
  const checkCapabilities = useCallback((caps: Capabilities) => {
    if (!caps.answer) {
      setError("Answer model not loaded");
      setModelsNeeded(true);
    } else {
      setError(null);
      setModelsNeeded(false);
    }
  }, []);

  // Poll download status
  const pollStatus = useCallback(async () => {
    const { data } = await apiFetch<DownloadStatus>("/api/models/status");
    if (data) {
      setDownloadStatus(data);

      if (!data.active && downloading) {
        setDownloading(false);
        if (pollInterval.current) {
          clearInterval(pollInterval.current);
          pollInterval.current = null;
        }

        // Refresh presets
        const { data: presetsData } =
          await apiFetch<PresetsResponse>("/api/presets");
        if (presetsData) {
          checkCapabilities(presetsData.capabilities);
        }
        const { data: statusData } =
          await apiFetch<AppStatusResponse>("/api/status");
        if (statusData) {
          setModelsNeeded(
            statusData.bootstrap.models.cachedCount <
              statusData.bootstrap.models.totalCount
          );
        }

        if (data.failed.length > 0) {
          setError(`Failed: ${data.failed.map((f) => f.type).join(", ")}`);
        }
      }
    }
  }, [downloading, checkCapabilities]);

  // Initial load
  useEffect(() => {
    void apiFetch<PresetsResponse>("/api/presets").then(({ data }) => {
      if (data) {
        setPresets(data.presets);
        setActiveId(data.activePreset);
        onPresetChange?.(data.activePreset);
        checkCapabilities(data.capabilities);
      }
      setLoading(false);
    });

    void apiFetch<AppStatusResponse>("/api/status").then(({ data }) => {
      if (data) {
        setModelsNeeded(
          data.bootstrap.models.cachedCount < data.bootstrap.models.totalCount
        );
      }
    });

    void apiFetch<DownloadStatus>("/api/models/status").then(({ data }) => {
      if (data?.active) {
        setDownloading(true);
        setDownloadStatus(data);
      }
    });
  }, [checkCapabilities]);

  // Polling
  useEffect(() => {
    if (downloading && !pollInterval.current) {
      pollInterval.current = setInterval(pollStatus, 1000);
    }
    return () => {
      if (pollInterval.current) {
        clearInterval(pollInterval.current);
        pollInterval.current = null;
      }
    };
  }, [downloading, pollStatus]);

  const activePreset = presets.find((p) => p.id === activeId);
  const activeExplanation = activePreset
    ? (PRESET_EXPLANATIONS[activePreset.id] ??
      "Switch between presets without redoing setup.")
    : "Select a preset";

  const syncFromStatus = useCallback(
    async (status: AppStatusResponse | null) => {
      if (!status) {
        return;
      }

      const readyModels =
        status.bootstrap.models.cachedCount >=
        status.bootstrap.models.totalCount;
      setModelsNeeded(!readyModels);
      checkCapabilities(status.capabilities);

      if (!readyModels) {
        setNotice("Switched preset. Downloading required models...");
        await handleDownload();
      }
    },
    [checkCapabilities]
  );

  const handleSelect = async (id: string) => {
    if (id === activeId || switching || downloading) return;

    setSwitching(true);
    setError(null);

    const { data, error: fetchError } = await apiFetch<SetPresetResponse>(
      "/api/presets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId: id }),
      }
    );

    setSwitching(false);

    if (fetchError) {
      setError(fetchError);
      return;
    }

    if (data?.success) {
      setActiveId(data.activePreset);
      onPresetChange?.(data.activePreset);
      checkCapabilities(data.capabilities);
      setOpen(false);
      const presetName = presets.find((preset) => preset.id === id)?.name ?? id;
      setNotice(
        data.embedModelChanged
          ? (data.note ??
              `Switched to ${presetName}. Run embeddings again so vector results catch up.`)
          : `Switched to ${presetName}`
      );
      const { data: statusData } =
        await apiFetch<AppStatusResponse>("/api/status");
      await syncFromStatus(statusData);
    }
  };

  const handleDownload = async () => {
    if (downloading) return;

    setDownloading(true);
    setError(null);

    const { error: fetchError } = await apiFetch("/api/models/pull", {
      method: "POST",
    });

    if (fetchError) {
      setError(fetchError);
      setDownloading(false);
      return;
    }

    void pollStatus();
  };

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Loading skeleton
  if (loading) {
    return (
      <div className="flex items-center gap-2">
        {showLabel && (
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">
            Preset
          </span>
        )}
        <div
          className={cn(
            "h-7 w-24 rounded",
            "bg-[hsl(var(--secondary)/0.1)]",
            "animate-pulse"
          )}
        />
      </div>
    );
  }

  if (presets.length === 0) return null;

  const displayName = formatPresetLabel(activePreset);

  return (
    <div className="relative" ref={containerRef}>
      {/* Label */}
      <div
        className={cn(
          "flex items-start",
          showLabel ? "flex-col gap-2" : "flex-row"
        )}
      >
        {showLabel && (
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">
            Preset
          </span>
        )}

        {/* Tube Display Button */}
        <button
          className={cn(
            "group relative flex items-center gap-2 px-3 py-1.5",
            "rounded border",
            // Tube display aesthetic - warm amber glow
            "border-[hsl(var(--secondary)/0.3)]",
            "bg-gradient-to-b from-[hsl(var(--secondary)/0.08)] to-[hsl(var(--secondary)/0.04)]",
            // Inner glow effect
            "shadow-[inset_0_1px_1px_hsl(var(--secondary)/0.1),inset_0_-1px_1px_hsl(var(--background)/0.5)]",
            // Hover: warm up the tube
            "hover:border-[hsl(var(--secondary)/0.5)]",
            "hover:bg-gradient-to-b hover:from-[hsl(var(--secondary)/0.12)] hover:to-[hsl(var(--secondary)/0.06)]",
            "hover:shadow-[inset_0_1px_2px_hsl(var(--secondary)/0.15),0_0_12px_-4px_hsl(var(--secondary)/0.3)]",
            // Transition
            "transition-all duration-300",
            // Focus
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--secondary)/0.5)]",
            // States
            switching && "opacity-70 pointer-events-none",
            open &&
              "border-[hsl(var(--secondary)/0.6)] shadow-[0_0_16px_-4px_hsl(var(--secondary)/0.4)]"
          )}
          disabled={switching}
          onClick={() => setOpen(!open)}
          ref={triggerRef}
          type="button"
        >
          {/* Status indicator */}
          {switching ? (
            <Loader2 className="size-3 animate-spin text-[hsl(var(--secondary))]" />
          ) : downloading ? (
            <Loader2 className="size-3 animate-spin text-[hsl(var(--secondary)/0.7)]" />
          ) : error || modelsNeeded ? (
            <AlertCircle className="size-3 text-amber-500" />
          ) : (
            <Sparkles className="size-3 text-[hsl(var(--secondary)/0.7)] transition-colors group-hover:text-[hsl(var(--secondary))]" />
          )}

          {/* Model name - nixie tube style */}
          <span
            className={cn(
              "font-mono text-xs tracking-wide",
              "text-[hsl(var(--secondary)/0.9)]",
              "transition-colors duration-300",
              "group-hover:text-[hsl(var(--secondary))]",
              // Subtle text glow on hover
              "group-hover:drop-shadow-[0_0_4px_hsl(var(--secondary)/0.5)]"
            )}
          >
            {downloading
              ? "Downloading..."
              : switching
                ? "Loading..."
                : displayName}
          </span>

          <ChevronDown
            className={cn(
              "size-3 text-[hsl(var(--secondary)/0.5)]",
              "transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </button>
      </div>

      {/* Dropdown Panel */}
      {open &&
        menuPosition &&
        createPortal(
          <div
            className={cn(
              "fixed z-[120]",
              "rounded-md border p-1",
              "max-h-[min(420px,calc(100vh-6rem))] overflow-y-auto",
              "border-[hsl(var(--secondary)/0.2)]",
              "bg-card/95 backdrop-blur-sm",
              "shadow-[0_8px_32px_-8px_hsl(var(--secondary)/0.2),0_0_1px_hsl(var(--secondary)/0.1)]",
              "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2",
              "duration-200"
            )}
            ref={menuRef}
            style={{
              left: `${menuPosition.left}px`,
              top: `${menuPosition.top}px`,
              width: `${menuPosition.width}px`,
            }}
          >
            {/* Download progress */}
            {downloading && downloadStatus && (
              <div className="mb-2 space-y-2 rounded bg-[hsl(var(--secondary)/0.05)] p-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {downloadStatus.currentType || "Preparing..."}
                  </span>
                  <span className="font-mono text-[10px] text-[hsl(var(--secondary)/0.7)]">
                    {downloadStatus.progress?.percent.toFixed(0) ?? 0}%
                  </span>
                </div>
                <div className="relative h-1.5 overflow-hidden rounded-full bg-muted/50">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      "bg-gradient-to-r from-[hsl(var(--secondary)/0.6)] to-[hsl(var(--secondary))]",
                      "shadow-[0_0_8px_hsl(var(--secondary)/0.5)]",
                      "transition-all duration-300"
                    )}
                    style={{
                      width: `${downloadStatus.progress?.percent ?? 0}%`,
                    }}
                  />
                </div>
                {downloadStatus.completed.length > 0 && (
                  <p className="font-mono text-[9px] text-muted-foreground/60">
                    Done: {downloadStatus.completed.join(", ")}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-0.5">
              {presets.map((preset) => {
                const isActive = preset.id === activeId;
                const baseName = extractBaseName(preset.name);
                const size = extractSize(preset.name);
                const explanation =
                  PRESET_EXPLANATIONS[preset.id] ??
                  "Pick this if the trade-off fits your machine.";

                return (
                  <button
                    className={cn(
                      "group/item flex w-full items-center justify-between gap-3",
                      "rounded px-3 py-2.5 text-left",
                      "transition-all duration-150",
                      "text-muted-foreground",
                      !isActive &&
                        "hover:bg-[hsl(var(--secondary)/0.08)] hover:text-foreground",
                      isActive && [
                        "bg-[hsl(var(--secondary)/0.1)]",
                        "text-[hsl(var(--secondary))]",
                      ],
                      (switching || downloading) &&
                        "pointer-events-none opacity-50"
                    )}
                    disabled={switching || downloading}
                    key={preset.id}
                    onClick={() => handleSelect(preset.id)}
                    type="button"
                  >
                    <div className="flex flex-col items-start gap-0.5">
                      <span
                        className={cn(
                          "font-medium text-sm",
                          isActive && "text-[hsl(var(--secondary))]"
                        )}
                      >
                        {baseName}
                      </span>
                      {size && (
                        <span className="font-mono text-[10px] text-muted-foreground/60">
                          {size}
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground/80">
                        {explanation}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground/50">
                        {`expand: ${formatModelRole(preset.expand ?? preset.gen)}`}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground/50">
                        {`answer: ${formatModelRole(preset.gen)}`}
                      </span>
                    </div>

                    {isActive && (
                      <Check className="size-4 text-[hsl(var(--secondary))]" />
                    )}
                  </button>
                );
              })}
            </div>

            {(error || modelsNeeded) && !downloading && (
              <>
                <div className="my-1 border-t border-border/50" />
                <div className="space-y-2 p-2">
                  {error && (
                    <p className="font-mono text-[10px] text-amber-500">
                      {error}
                    </p>
                  )}
                  {modelsNeeded && (
                    <button
                      className={cn(
                        "flex w-full items-center justify-center gap-2",
                        "rounded border px-3 py-2",
                        "border-[hsl(var(--secondary)/0.3)]",
                        "bg-[hsl(var(--secondary)/0.05)]",
                        "font-medium text-[hsl(var(--secondary))] text-xs",
                        "transition-all duration-200",
                        "hover:border-[hsl(var(--secondary)/0.5)]",
                        "hover:bg-[hsl(var(--secondary)/0.1)]",
                        "hover:shadow-[0_0_12px_-4px_hsl(var(--secondary)/0.3)]"
                      )}
                      onClick={handleDownload}
                      type="button"
                    >
                      <Download className="size-3.5" />
                      Download Preset Models
                    </button>
                  )}
                </div>
              </>
            )}

            <div className="mt-1 border-t border-border/30 px-3 py-2">
              <p className="font-mono text-[9px] text-muted-foreground/50">
                Controls retrieval expansion and AI answers
              </p>
            </div>
          </div>,
          document.body
        )}

      {showDetails && activePreset && (
        <div className="mt-4 rounded-2xl border border-secondary/20 bg-background/80 shadow-sm">
          <div
            className="border-border/50 border-b"
            style={{ padding: "20px 24px" }}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="font-semibold text-base">
                    {activePreset.name}
                  </div>
                  {extractSize(activePreset.name) && (
                    <Badge variant="outline">
                      {extractSize(activePreset.name)}
                    </Badge>
                  )}
                  {isCustomPreset(activePreset) && (
                    <Badge className="border-secondary/30 bg-secondary/10 text-secondary hover:bg-secondary/10">
                      Tuned
                    </Badge>
                  )}
                </div>
                <p className="text-muted-foreground text-sm">
                  {activeExplanation}
                </p>
              </div>
              <Badge variant="outline">{`${presets.length} presets available`}</Badge>
            </div>
          </div>

          <div style={{ padding: "20px 24px" }}>
            <div className="grid gap-4 md:grid-cols-2">
              <div
                className="rounded-xl border border-border/60 bg-card/70 shadow-none"
                style={{ padding: "16px" }}
              >
                <div className="mb-2 flex items-center gap-2 font-medium text-sm">
                  <ScanSearch className="size-4 text-secondary" />
                  Retrieval profile
                </div>
                <p className="text-muted-foreground text-sm">
                  {activePreset.id === "slim"
                    ? "Quickest local setup with the lightest footprint."
                    : activePreset.id === "balanced"
                      ? "Good general-purpose trade-off for most projects."
                      : activePreset.id === "quality"
                        ? "Highest local answer quality with heavier resource use."
                        : "Custom tuned profile layered on top of the built-in options."}
                </p>
              </div>
              <div
                className="rounded-xl border border-border/60 bg-card/70 shadow-none"
                style={{ padding: "16px" }}
              >
                <div className="mb-2 flex items-center gap-2 font-medium text-sm">
                  <BadgeCheck className="size-4 text-secondary" />
                  Active models
                </div>
                <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
                  <div>{`expand: ${formatModelRole(activePreset.expand ?? activePreset.gen)}`}</div>
                  <div>{`answer: ${formatModelRole(activePreset.gen)}`}</div>
                  <div>{`rerank: ${formatModelRole(activePreset.rerank)}`}</div>
                </div>
              </div>
            </div>

            {showDownloadAction && (error || modelsNeeded) && !downloading && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-4">
                <p className="text-amber-500 text-sm">
                  {error ?? "This preset still needs local model files."}
                </p>
                <button
                  className={cn(
                    "flex items-center justify-center gap-2 rounded border px-3 py-2",
                    "border-[hsl(var(--secondary)/0.3)] bg-[hsl(var(--secondary)/0.05)]",
                    "font-medium text-[hsl(var(--secondary))] text-xs transition-all duration-200",
                    "hover:border-[hsl(var(--secondary)/0.5)] hover:bg-[hsl(var(--secondary)/0.1)]"
                  )}
                  onClick={handleDownload}
                  type="button"
                >
                  <Download className="size-3.5" />
                  Download preset models
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {notice && <div className="mt-2 text-primary text-xs">{notice}</div>}
    </div>
  );
}
