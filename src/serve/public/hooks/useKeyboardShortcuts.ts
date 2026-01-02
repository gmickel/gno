/**
 * useKeyboardShortcuts - Global keyboard shortcut handler hook.
 *
 * Features:
 * - Single-key shortcuts (GitHub/Gmail pattern)
 * - Skips in text inputs and dialogs
 * - Doesn't fire when Ctrl/Cmd/Alt held (prevents browser conflicts)
 */

import { useEffect, useMemo } from "react";

export interface Shortcut {
  /** Key to match (case-insensitive) */
  key: string;
  /** Require Ctrl key */
  meta?: boolean;
  /** Require Shift key (undefined = don't care) */
  shift?: boolean;
  /** Action to execute */
  action: () => void;
  /** Skip when user is in text input (default: true) */
  skipInInput?: boolean;
  /** Skip when inside a dialog (default: true) */
  skipInDialog?: boolean;
}

/**
 * Check if event target is an input element
 */
function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;

  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea") return true;
  if (target.isContentEditable) return true;

  // Check for CodeMirror
  if (target.closest(".cm-editor")) return true;

  return false;
}

/**
 * Check if event target is inside a dialog
 */
function isInDialog(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('[role="dialog"]'));
}

/**
 * Register keyboard shortcuts
 */
export function useKeyboardShortcuts(shortcuts: Shortcut[]): void {
  // Memoize to prevent unnecessary re-registrations
  const memoizedShortcuts = useMemo(() => shortcuts, [shortcuts]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const shortcut of memoizedShortcuts) {
        // Check key match first (most common failure)
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
        if (!keyMatch) continue;

        // Skip inside dialogs (default: true)
        const skipDialog = shortcut.skipInDialog ?? true;
        if (skipDialog && isInDialog(e.target)) continue;

        // Skip in text inputs (default: true)
        const skipInput = shortcut.skipInInput ?? true;
        if (skipInput && isInputElement(e.target)) continue;

        // Modifier handling
        if (shortcut.meta) {
          // Require Ctrl for meta shortcuts
          if (!e.ctrlKey) continue;
        } else {
          // Single-key shortcuts: don't fire when any modifier held
          // Prevents hijacking Cmd+N on macOS, Ctrl+K on Windows, etc.
          if (e.ctrlKey || e.metaKey || e.altKey) continue;
        }

        // Shift: only check if explicitly specified (undefined = don't care)
        // This allows Shift+N to still trigger 'n' shortcuts
        if (shortcut.shift !== undefined && e.shiftKey !== shortcut.shift) {
          continue;
        }

        e.preventDefault();
        shortcut.action();
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [memoizedShortcuts]);
}
