import { CheckIcon, ChevronDownIcon, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/use-api';
import { cn } from '../lib/utils';
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
}

/**
 * Extract size hint from preset name, e.g. "Slim (Fast, ~1GB)" -> "~1GB"
 */
function extractSize(name: string): string | null {
  const match = name.match(/~[\d.]+GB/);
  return match ? match[0] : null;
}

/**
 * Extract description from preset name, e.g. "Slim (Fast, ~1GB)" -> "Fast"
 */
function extractDesc(name: string): string | null {
  const match = name.match(/\(([^,]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Extract base name, e.g. "Slim (Fast, ~1GB)" -> "Slim"
 */
function extractBaseName(name: string): string {
  return name.split('(')[0].trim();
}

export function PresetSelector() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<PresetsResponse>('/api/presets').then(({ data }) => {
      if (data) {
        setPresets(data.presets);
        setActiveId(data.activePreset);
      }
      setLoading(false);
    });
  }, []);

  const activePreset = presets.find((p) => p.id === activeId);

  if (loading || presets.length === 0) {
    return null;
  }

  // Note: Changing presets at runtime requires server restart
  // This selector shows current config, future: could restart context
  const handleSelect = (id: string) => {
    setActiveId(id);
    // TODO: In future, POST to /api/presets to change and restart context
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="group gap-2 font-normal text-muted-foreground hover:text-foreground"
          size="sm"
          variant="ghost"
        >
          <SlidersHorizontal className="size-3.5 text-muted-foreground/70 transition-colors group-hover:text-primary" />
          <span className="hidden sm:inline">
            {activePreset ? extractBaseName(activePreset.name) : 'Preset'}
          </span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs uppercase tracking-wider">
          Model Preset
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup onValueChange={handleSelect} value={activeId}>
          {presets.map((preset) => {
            const baseName = extractBaseName(preset.name);
            const desc = extractDesc(preset.name);
            const size = extractSize(preset.name);

            return (
              <DropdownMenuRadioItem
                className="cursor-pointer py-2.5"
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
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground/60">
          Restart server to apply changes
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
