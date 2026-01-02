/**
 * HelpButton - A scholar's reference mark for keyboard shortcuts.
 *
 * Design: "Marginalia" - Like a faded notation in an old manuscript
 * that reveals itself when the reader's attention draws near.
 *
 * Uses Old Gold (secondary) to distinguish from primary actions,
 * evoking warm candlelight on aged paper.
 */

import { cn } from "../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

export interface HelpButtonProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when button clicked */
  onClick: () => void;
}

export function HelpButton({ className, onClick }: HelpButtonProps) {
  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Keyboard shortcuts"
            className={cn(
              // Position: margin notation, slightly inset
              "group fixed left-4 bottom-4 z-50",
              // Size: small, refined - like a superscript
              "flex size-7 items-center justify-center",
              // Base state: faded marginalia
              "rounded-sm border border-transparent",
              "bg-transparent text-muted-foreground/30",
              // The reference mark itself - serif typography
              "font-serif text-sm italic",
              // Hover: ink freshens, warm gold emerges
              "hover:text-[hsl(var(--secondary))]",
              "hover:border-[hsl(var(--secondary)/0.2)]",
              "hover:bg-[hsl(var(--secondary)/0.05)]",
              // Subtle ink-bleed glow on hover
              "hover:shadow-[0_0_12px_-4px_hsl(var(--secondary)/0.4)]",
              // Refined transition - slow reveal like turning a page
              "transition-all duration-500 ease-out",
              // Focus: accessible but subtle
              "focus-visible:text-[hsl(var(--secondary))]",
              "focus-visible:outline-none focus-visible:ring-1",
              "focus-visible:ring-[hsl(var(--secondary)/0.5)]",
              "focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              // Cursor
              "cursor-pointer",
              className
            )}
            onClick={onClick}
            type="button"
          >
            {/* The mark: a serif question mark, styled like manuscript notation */}
            <span
              className={cn(
                "select-none",
                // Subtle lift on hover
                "transition-transform duration-300",
                "group-hover:-translate-y-px group-hover:scale-105"
              )}
            >
              ?
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          className={cn(
            // Scholarly tooltip styling
            "border-[hsl(var(--secondary)/0.2)] bg-card/95",
            "shadow-[0_4px_20px_-4px_hsl(var(--secondary)/0.15)]",
            "backdrop-blur-sm"
          )}
          side="right"
          sideOffset={8}
        >
          <p className="flex items-center gap-2.5 font-sans text-sm">
            <span className="text-muted-foreground">Shortcuts</span>
            <kbd
              className={cn(
                "inline-flex min-w-[1.25rem] items-center justify-center",
                "rounded border px-1.5 py-0.5",
                "border-[hsl(var(--secondary)/0.3)] bg-[hsl(var(--secondary)/0.1)]",
                "font-serif text-[11px] italic text-[hsl(var(--secondary))]",
                // Subtle pressed effect
                "shadow-[inset_0_1px_2px_hsl(var(--background)/0.3)]"
              )}
            >
              ?
            </kbd>
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
