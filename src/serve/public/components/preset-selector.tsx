import {
  AlertCircle,
  CheckIcon,
  ChevronDownIcon,
  Download,
  Loader2,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../hooks/use-api';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Progress } from './ui/progress';

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

// Top-level regex patterns for performance
const SIZE_REGEX = /~[\d.]+GB/;
const DESC_REGEX = /\(([^,]+)/;

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

function extractSize(name: string): string | null {
  const match = name.match(SIZE_REGEX);
  return match ? match[0] : null;
}

function extractDesc(name: string): string | null {
  const match = name.match(DESC_REGEX);
  return match ? match[1].trim() : null;
}

function extractBaseName(name: string): string {
  return name.split('(')[0].trim();
}

function formatBytes(bytes: number): string {
  if (bytes < KB) {
    return `${bytes} B`;
  }
  if (bytes < MB) {
    return `${(bytes / KB).toFixed(1)} KB`;
  }
  if (bytes < GB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  return `${(bytes / GB).toFixed(2)} GB`;
}

function getButtonIcon(
  switching: boolean,
  downloading: boolean,
  hasError: boolean
) {
  if (switching) {
    return <Loader2 className="size-3.5 animate-spin text-primary" />;
  }
  if (downloading) {
    return <Loader2 className="size-3.5 animate-spin text-blue-500" />;
  }
  if (hasError) {
    return <AlertCircle className="size-3.5 text-amber-500" />;
  }
  return (
    <SlidersHorizontal className="size-3.5 text-muted-foreground/70 transition-colors group-hover:text-primary" />
  );
}

function getButtonLabel(
  switching: boolean,
  downloading: boolean,
  activePreset: Preset | undefined
): string {
  if (switching) {
    return 'Switching...';
  }
  if (downloading) {
    return 'Downloading...';
  }
  return activePreset ? extractBaseName(activePreset.name) : 'Preset';
}

export function PresetSelector() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelsNeeded, setModelsNeeded] = useState(false);

  // Download state
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus | null>(
    null
  );
  const pollInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check capabilities and set modelsNeeded flag
  const checkCapabilities = useCallback((caps: Capabilities) => {
    const missing: string[] = [];
    if (!caps.vector) {
      missing.push('vector search');
    }
    if (!caps.answer) {
      missing.push('AI answers');
    }

    if (missing.length > 0) {
      setError(`Missing: ${missing.join(', ')}`);
      setModelsNeeded(true);
    } else {
      setError(null);
      setModelsNeeded(false);
    }
  }, []);

  // Poll download status
  const pollStatus = useCallback(async () => {
    const { data } = await apiFetch<DownloadStatus>('/api/models/status');
    if (data) {
      setDownloadStatus(data);

      // Download finished
      if (!data.active && downloading) {
        setDownloading(false);
        if (pollInterval.current) {
          clearInterval(pollInterval.current);
          pollInterval.current = null;
        }

        // Refresh presets to get updated capabilities
        const { data: presetsData } =
          await apiFetch<PresetsResponse>('/api/presets');
        if (presetsData) {
          checkCapabilities(presetsData.capabilities);
        }

        // Show any failures
        if (data.failed.length > 0) {
          setError(`Failed: ${data.failed.map((f) => f.type).join(', ')}`);
        }
      }
    }
  }, [downloading, checkCapabilities]);

  // Initial load
  useEffect(() => {
    apiFetch<PresetsResponse>('/api/presets').then(({ data }) => {
      if (data) {
        setPresets(data.presets);
        setActiveId(data.activePreset);
        checkCapabilities(data.capabilities);
      }
      setLoading(false);
    });

    // Check if download already in progress
    apiFetch<DownloadStatus>('/api/models/status').then(({ data }) => {
      if (data?.active) {
        setDownloading(true);
        setDownloadStatus(data);
      }
    });
  }, [checkCapabilities]);

  // Start/stop polling
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

  if (loading || presets.length === 0) {
    return null;
  }

  const handleSelect = async (id: string) => {
    if (id === activeId || switching || downloading) {
      return;
    }

    setSwitching(true);
    setError(null);

    const { data, error: fetchError } = await apiFetch<SetPresetResponse>(
      '/api/presets',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    }
  };

  const handleDownload = async () => {
    if (downloading) {
      return;
    }

    setDownloading(true);
    setError(null);

    const { error: fetchError } = await apiFetch('/api/models/pull', {
      method: 'POST',
    });

    if (fetchError) {
      setError(fetchError);
      setDownloading(false);
      return;
    }

    // Start polling
    pollStatus();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="group gap-2 font-normal text-muted-foreground hover:text-foreground"
          disabled={switching}
          size="sm"
          variant="ghost"
        >
          {getButtonIcon(
            switching,
            downloading,
            Boolean(error || modelsNeeded)
          )}
          <span className="hidden sm:inline">
            {getButtonLabel(switching, downloading, activePreset)}
          </span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 border-border bg-card">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs uppercase tracking-wider">
          Model Preset
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Download progress */}
        {downloading && downloadStatus && (
          <>
            <div className="space-y-2 px-2 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {downloadStatus.currentType || 'Starting...'}
                </span>
                {downloadStatus.progress && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {formatBytes(downloadStatus.progress.downloadedBytes)} /{' '}
                    {formatBytes(downloadStatus.progress.totalBytes)}
                  </span>
                )}
              </div>
              <Progress value={downloadStatus.progress?.percent ?? 0} />
              {downloadStatus.completed.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  Done: {downloadStatus.completed.join(', ')}
                </div>
              )}
            </div>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuRadioGroup onValueChange={handleSelect} value={activeId}>
          {presets.map((preset) => {
            const baseName = extractBaseName(preset.name);
            const desc = extractDesc(preset.name);
            const size = extractSize(preset.name);

            return (
              <DropdownMenuRadioItem
                className="cursor-pointer py-2.5"
                disabled={switching || downloading}
                key={preset.id}
                value={preset.id}
              >
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{baseName}</span>
                    {desc && (
                      <span className="text-muted-foreground text-xs">
                        {desc}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {size && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {size}
                      </span>
                    )}
                    {preset.id === activeId && (
                      <CheckIcon className="size-4 text-primary" />
                    )}
                  </div>
                </div>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>

        {/* Error or download prompt */}
        {(error || modelsNeeded) && !downloading && (
          <>
            <DropdownMenuSeparator />
            <div className="space-y-2 px-2 py-2">
              {error && (
                <div className="text-[10px] text-destructive">{error}</div>
              )}
              {modelsNeeded && (
                <Button
                  className="w-full gap-2"
                  onClick={handleDownload}
                  size="sm"
                  variant="outline"
                >
                  <Download className="size-3.5" />
                  Download Models
                </Button>
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
