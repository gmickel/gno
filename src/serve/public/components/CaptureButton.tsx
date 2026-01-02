/**
 * CaptureButton - Floating action button for quick document capture.
 *
 * Features:
 * - Fixed position bottom-right
 * - Triggers parent's onClick handler
 * - Subtle hover animation
 *
 * Note: Modal and 'n' shortcut are managed at App level for single instance.
 */

import { PenIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

export interface CaptureButtonProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when button clicked */
  onClick: () => void;
}

export function CaptureButton({ className, onClick }: CaptureButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className={cn(
              "group fixed right-6 bottom-6 z-50 size-14 rounded-full",
              "bg-primary hover:bg-primary/90 text-primary-foreground",
              "shadow-[0_0_20px_-5px_hsl(var(--primary)/0.5)]",
              "hover:shadow-[0_0_30px_-5px_hsl(var(--primary)/0.7)]",
              "transition-all duration-300 hover:scale-110",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "animate-pulse-glow",
              className
            )}
            onClick={onClick}
            size="icon"
          >
            <PenIcon className="size-6 transition-transform duration-200 group-hover:rotate-[-8deg]" />
            <span className="sr-only">New note (N)</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>New note (N)</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
