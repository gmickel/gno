/**
 * AIModelSelector - Vacuum tube display for LLM preset selection.
 *
 * Design: "Tube Display" - Evokes vintage radio tuners and oscilloscope
 * selectors. The current model glows warmly in an amber display window,
 * suggesting analog warmth in a digital interface.
 *
 * Uses Old Gold (secondary) to clearly distinguish from search/primary
 * actions - this controls AI answer generation only.
 */

import {
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";

interface Preset {
  id: string;
  name: string;
  embed: string;
  rerank: string;
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

// Extract readable model name from preset name
const SIZE_REGEX = /~[\d.]+GB/;

function extractBaseName(name: string): string {
  return name.split("(")[0].trim();
}

function extractSize(name: string): string | null {
  const match = name.match(SIZE_REGEX);
  return match ? match[0] : null;
}

export function AIModelSelector() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelsNeeded, setModelsNeeded] = useState(false);
  const [open, setOpen] = useState(false);

  // Download state
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(
    null
  );
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Check capabilities
  const checkCapabilities = useCallback((caps: Capabilities) => {
    if (!caps.answer) {
      setError("AI model not loaded");
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
        checkCapabilities(data.capabilities);
      }
      setLoading(false);
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
      checkCapabilities(data.capabilities);
      setOpen(false);
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

  // Loading skeleton
  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">
          AI Model
        </span>
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

  const displayName = activePreset
    ? extractBaseName(activePreset.name)
    : "Select";

  return (
    <div className="relative" ref={containerRef}>
      {/* Label */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40">
          AI Model
        </span>

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
      {open && (
        <div
          className={cn(
            "absolute top-full right-0 z-50 mt-2",
            "min-w-[240px] rounded-md border p-1",
            // Panel styling - instrument panel aesthetic
            "border-[hsl(var(--secondary)/0.2)]",
            "bg-card/95 backdrop-blur-sm",
            "shadow-[0_8px_32px_-8px_hsl(var(--secondary)/0.2),0_0_1px_hsl(var(--secondary)/0.1)]",
            // Entrance animation
            "animate-in fade-in-0 zoom-in-95 slide-in-from-top-2",
            "duration-200"
          )}
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
              {/* Vintage meter bar */}
              <div className="relative h-1.5 overflow-hidden rounded-full bg-muted/50">
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    "bg-gradient-to-r from-[hsl(var(--secondary)/0.6)] to-[hsl(var(--secondary))]",
                    "shadow-[0_0_8px_hsl(var(--secondary)/0.5)]",
                    "transition-all duration-300"
                  )}
                  style={{ width: `${downloadStatus.progress?.percent ?? 0}%` }}
                />
              </div>
              {downloadStatus.completed.length > 0 && (
                <p className="font-mono text-[9px] text-muted-foreground/60">
                  Done: {downloadStatus.completed.join(", ")}
                </p>
              )}
            </div>
          )}

          {/* Preset options */}
          <div className="space-y-0.5">
            {presets.map((preset) => {
              const isActive = preset.id === activeId;
              const baseName = extractBaseName(preset.name);
              const size = extractSize(preset.name);

              return (
                <button
                  className={cn(
                    "group/item flex w-full items-center justify-between gap-3",
                    "rounded px-3 py-2.5",
                    "transition-all duration-150",
                    // Base
                    "text-muted-foreground",
                    // Hover
                    !isActive &&
                      "hover:bg-[hsl(var(--secondary)/0.08)] hover:text-foreground",
                    // Active state
                    isActive && [
                      "bg-[hsl(var(--secondary)/0.1)]",
                      "text-[hsl(var(--secondary))]",
                    ],
                    // Disabled
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
                  </div>

                  {isActive && (
                    <Check className="size-4 text-[hsl(var(--secondary))]" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Error / Download prompt */}
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
                    Download Models
                  </button>
                )}
              </div>
            </>
          )}

          {/* Footer note */}
          <div className="mt-1 border-t border-border/30 px-3 py-2">
            <p className="font-mono text-[9px] text-muted-foreground/50">
              Controls AI answer generation only
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
