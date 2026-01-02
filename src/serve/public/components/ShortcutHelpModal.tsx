/**
 * ShortcutHelpModal - Displays available keyboard shortcuts.
 *
 * Features:
 * - Grouped by context (Global, Editor, Navigation)
 * - Platform-appropriate modifier display
 * - Triggered by Cmd+/ or help button
 */

import { KeyboardIcon } from "lucide-react";

import { modKey } from "../hooks/useKeyboardShortcuts";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

export interface ShortcutHelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ShortcutItem {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutItem[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "Global",
    shortcuts: [
      { keys: `${modKey}+N`, description: "New note" },
      { keys: `${modKey}+K`, description: "Focus search" },
      { keys: `${modKey}+/`, description: "Show shortcuts" },
      { keys: "Esc", description: "Close modal" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: `${modKey}+S`, description: "Save" },
      { keys: `${modKey}+B`, description: "Bold" },
      { keys: `${modKey}+I`, description: "Italic" },
      { keys: `${modKey}+K`, description: "Insert link" },
      { keys: "Esc", description: "Close editor" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [{ keys: `${modKey}+Enter`, description: "Submit form" }],
  },
];

export function ShortcutHelpModal({
  open,
  onOpenChange,
}: ShortcutHelpModalProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyboardIcon className="size-5" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {shortcutGroups.map((group) => (
            <div key={group.title}>
              <h3 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                {group.title}
              </h3>
              <div className="space-y-2.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    className="flex items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
                    key={shortcut.keys}
                  >
                    <span className="text-sm">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.split("+").map((key, i) => (
                        <span key={key}>
                          {i > 0 && (
                            <span className="mx-0.5 text-muted-foreground/50">
                              +
                            </span>
                          )}
                          <kbd className="inline-flex min-w-[1.75rem] items-center justify-center rounded border border-border/80 bg-gradient-to-b from-muted/80 to-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground shadow-[0_2px_0_hsl(var(--border)),inset_0_1px_0_hsl(var(--background)/0.5)]">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
