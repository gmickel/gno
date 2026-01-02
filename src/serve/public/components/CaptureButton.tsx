/**
 * CaptureButton - Floating action button for quick document capture.
 *
 * Features:
 * - Fixed position bottom-right
 * - Opens CaptureModal
 * - Responds to Cmd+N shortcut
 * - Subtle hover animation
 */

import { PenIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { CaptureModal } from "./CaptureModal";
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
  /** Callback when document created successfully */
  onSuccess?: (uri: string) => void;
}

export function CaptureButton({ className, onSuccess }: CaptureButtonProps) {
  const [open, setOpen] = useState(false);

  // Keyboard shortcut: Cmd+N / Ctrl+N
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "n") {
      e.preventDefault();
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
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
              onClick={() => setOpen(true)}
              size="icon"
            >
              <PenIcon className="size-6" />
              <span className="sr-only">New note (Cmd+N)</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>New note (⌘N)</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <CaptureModal
        onOpenChange={setOpen}
        onSuccess={(uri) => {
          onSuccess?.(uri);
        }}
        open={open}
      />
    </>
  );
}
