/**
 * CaptureButton - Floating action button for quick document capture.
 *
 * Features:
 * - Fixed position bottom-right
 * - Triggers parent's onClick handler
 * - Subtle hover animation
 *
 * Note: Modal and Cmd+N shortcut are managed at App level for single instance.
 */

import { PenIcon } from "lucide-react";

import { modKey } from "../hooks/useKeyboardShortcuts";
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
              "fixed right-6 bottom-6 z-50 size-14 rounded-full shadow-lg",
              "bg-primary hover:bg-primary/90 text-primary-foreground",
              "transition-all duration-200 hover:scale-105 hover:shadow-xl",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              className
            )}
            onClick={onClick}
            size="icon"
          >
            <PenIcon className="size-6" />
            <span className="sr-only">New note ({modKey}+N)</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>New note ({modKey}N)</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
