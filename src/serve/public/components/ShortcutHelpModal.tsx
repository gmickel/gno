/**
 * ShortcutHelpModal - Card catalog reference for keyboard shortcuts.
 *
 * Design: "Card Catalog" - Like a librarian's well-organized reference card.
 * Two-column layout spreads content horizontally. Typewriter-style keys
 * with embossed shadows evoke vintage office equipment.
 *
 * Uses Old Gold (secondary) for accents and dividers to maintain
 * the scholarly warmth of the Scholarly Dusk theme.
 */

import { KeyboardIcon } from "lucide-react";

import { cn } from "../lib/utils";
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
      { keys: "N", description: "New note" },
      { keys: "/", description: "Focus search" },
      { keys: "T", description: "Cycle search depth" },
      { keys: "?", description: "Show shortcuts" },
      { keys: "Esc", description: "Close modal" },
    ],
  },
  {
    title: "Editor",
    shortcuts: [
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Ctrl+B", description: "Bold" },
      { keys: "Ctrl+I", description: "Italic" },
      { keys: "Ctrl+K", description: "Insert link" },
      { keys: "Esc", description: "Close editor" },
    ],
  },
];

// Separate footer shortcut
const footerShortcut: ShortcutItem = {
  keys: "Ctrl+Enter",
  description: "Submit form",
};

function KeyCombo({ keys }: { keys: string }) {
  const parts = keys.split("+");

  return (
    <div className="flex items-center gap-1">
      {parts.map((key, i) => (
        <span className="contents" key={key}>
          {i > 0 && (
            <span className="text-[10px] text-muted-foreground/40">+</span>
          )}
          <kbd
            className={cn(
              "inline-flex min-w-[1.5rem] items-center justify-center",
              "rounded-[3px] border px-1.5 py-0.5",
              // Typewriter key aesthetic - cream on dark
              "border-[hsl(var(--secondary)/0.25)]",
              "bg-gradient-to-b from-[hsl(40,20%,18%)] to-[hsl(40,15%,14%)]",
              // Embossed shadow - key sits slightly raised
              "shadow-[0_2px_0_hsl(var(--secondary)/0.15),inset_0_1px_0_hsl(var(--secondary)/0.1)]",
              // Typography
              "font-mono text-[11px] tracking-wide",
              "text-[hsl(40,30%,75%)]"
            )}
          >
            {key}
          </kbd>
        </span>
      ))}
    </div>
  );
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutItem }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4",
        "rounded px-2 py-1.5",
        "transition-colors duration-150",
        "hover:bg-[hsl(var(--secondary)/0.05)]"
      )}
    >
      <span className="text-[13px] text-muted-foreground">
        {shortcut.description}
      </span>
      <KeyCombo keys={shortcut.keys} />
    </div>
  );
}

function ShortcutGroupCard({ group }: { group: ShortcutGroup }) {
  return (
    <div className="space-y-2">
      {/* Card catalog divider header */}
      <div
        className={cn(
          "flex items-center gap-2 pb-1",
          "border-b border-[hsl(var(--secondary)/0.15)]"
        )}
      >
        <h3
          className={cn(
            "font-mono text-[10px] font-medium uppercase tracking-[0.15em]",
            "text-[hsl(var(--secondary)/0.7)]"
          )}
        >
          {group.title}
        </h3>
        <div className="h-px flex-1 bg-gradient-to-r from-[hsl(var(--secondary)/0.1)] to-transparent" />
      </div>

      {/* Shortcuts list */}
      <div className="space-y-0.5">
        {group.shortcuts.map((shortcut) => (
          <ShortcutRow key={shortcut.keys} shortcut={shortcut} />
        ))}
      </div>
    </div>
  );
}

export function ShortcutHelpModal({
  open,
  onOpenChange,
}: ShortcutHelpModalProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className={cn(
          // Wider modal for two-column layout
          "max-w-lg",
          // Solid background - no transparency
          "border-[hsl(var(--secondary)/0.2)]",
          "bg-[hsl(220,15%,13%)]",
          // Subtle shadow like paper lifted off desk
          "shadow-[0_8px_32px_-8px_hsl(var(--secondary)/0.2)]"
        )}
      >
        <DialogHeader>
          <DialogTitle
            className={cn(
              "flex items-center gap-2.5",
              "text-[hsl(var(--secondary))]"
            )}
          >
            <KeyboardIcon className="size-5" />
            <span className="font-medium tracking-wide">
              Keyboard Shortcuts
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Two-column grid for main groups */}
        <div className="mt-4 grid grid-cols-2 gap-6">
          {shortcutGroups.map((group) => (
            <ShortcutGroupCard group={group} key={group.title} />
          ))}
        </div>

        {/* Footer shortcut - single row */}
        <div
          className={cn(
            "mt-4 flex items-center justify-between",
            "rounded-md border border-dashed px-3 py-2",
            "border-[hsl(var(--secondary)/0.15)]",
            "bg-[hsl(var(--secondary)/0.03)]"
          )}
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "font-mono text-[9px] uppercase tracking-[0.15em]",
                "text-[hsl(var(--secondary)/0.5)]"
              )}
            >
              Forms
            </span>
            <span className="text-[13px] text-muted-foreground">
              {footerShortcut.description}
            </span>
          </div>
          <KeyCombo keys={footerShortcut.keys} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
