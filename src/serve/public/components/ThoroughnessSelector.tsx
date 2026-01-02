/**
 * ThoroughnessSelector - Precision dial for search quality vs speed.
 *
 * Design: "Calibration Dial" - Like a rotary selector on vintage
 * laboratory equipment. Brass tones, engraved feel, precise detents.
 *
 * Uses Old Gold (secondary) for warmth, with timing annotations
 * styled as instrument readouts.
 */

import { Gauge, Rabbit, Sparkles } from "lucide-react";

import { cn } from "../lib/utils";

export type Thoroughness = "fast" | "balanced" | "thorough";

export interface ThoroughnessSelectorProps {
  value: Thoroughness;
  onChange: (value: Thoroughness) => void;
  disabled?: boolean;
  className?: string;
}

interface Option {
  id: Thoroughness;
  label: string;
  timing: string;
  icon: React.ElementType;
}

const options: Option[] = [
  { id: "fast", label: "Fast", timing: "BM25", icon: Rabbit },
  { id: "balanced", label: "Balanced", timing: "~2s", icon: Gauge },
  { id: "thorough", label: "Thorough", timing: "~5s", icon: Sparkles },
];

export function ThoroughnessSelector({
  value,
  onChange,
  disabled = false,
  className,
}: ThoroughnessSelectorProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5",
        disabled && "pointer-events-none opacity-50",
        className
      )}
    >
      {/* Label styled as instrument marking */}
      <span className="mr-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
        Depth
      </span>

      {/* The dial housing */}
      <div
        className={cn(
          "relative flex items-stretch",
          // Machined metal bezel feel
          "rounded-md border border-border/60",
          "bg-gradient-to-b from-muted/30 to-muted/60",
          "shadow-[inset_0_1px_2px_hsl(var(--background)/0.5),0_1px_0_hsl(var(--foreground)/0.03)]"
        )}
        role="radiogroup"
      >
        {options.map((option, index) => {
          const isSelected = value === option.id;
          const Icon = option.icon;

          return (
            <button
              aria-checked={isSelected}
              className={cn(
                "group relative flex items-center gap-1.5 px-2.5 py-1.5",
                "transition-all duration-200",
                // Detent separators (except first)
                index > 0 &&
                  "before:absolute before:left-0 before:top-1/4 before:h-1/2 before:w-px before:bg-border/40",
                // Base state
                "text-muted-foreground/70",
                // Hover
                !isSelected && "hover:text-muted-foreground hover:bg-muted/30",
                // Selected state - warm brass/gold feel
                isSelected && [
                  "text-[hsl(var(--secondary))]",
                  "bg-[hsl(var(--secondary)/0.12)]",
                  // Subtle inner glow
                  "shadow-[inset_0_0_8px_hsl(var(--secondary)/0.15)]",
                ],
                // Focus
                "focus-visible:outline-none focus-visible:ring-1",
                "focus-visible:ring-[hsl(var(--secondary)/0.5)]",
                "focus-visible:z-10",
                // Corners
                index === 0 && "rounded-l-[5px]",
                index === options.length - 1 && "rounded-r-[5px]"
              )}
              disabled={disabled}
              key={option.id}
              onClick={() => onChange(option.id)}
              role="radio"
              title={`${option.label} search (${option.timing})`}
              type="button"
            >
              {/* Icon */}
              <Icon
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  isSelected && "scale-110"
                )}
              />

              {/* Label */}
              <span className="text-xs font-medium">{option.label}</span>

              {/* Timing readout - only on selected */}
              {isSelected && (
                <span
                  className={cn(
                    "ml-0.5 font-mono text-[9px]",
                    "text-[hsl(var(--secondary)/0.7)]",
                    "animate-fade-in"
                  )}
                >
                  {option.timing}
                </span>
              )}
            </button>
          );
        })}

        {/* Subtle indicator dot under selected option */}
        <div
          className={cn(
            "absolute -bottom-0.5 h-0.5 w-4 rounded-full",
            "bg-[hsl(var(--secondary)/0.6)]",
            "transition-all duration-300 ease-out",
            "shadow-[0_0_4px_hsl(var(--secondary)/0.4)]"
          )}
          style={{
            left: `calc(${options.findIndex((o) => o.id === value) * 33.33}% + 16.66% - 8px)`,
          }}
        />
      </div>
    </div>
  );
}
