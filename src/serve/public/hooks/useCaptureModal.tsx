/**
 * CaptureModal context for global modal state management.
 *
 * Provides:
 * - Single modal instance at App level
 * - 'n' shortcut wiring (single-key, skips in text inputs)
 * - openCapture() function for triggering from anywhere
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { CaptureModal } from "../components/CaptureModal";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

interface CaptureModalContextValue {
  /** Open the capture modal */
  openCapture: () => void;
  /** Whether the modal is open */
  isOpen: boolean;
}

const CaptureModalContext = createContext<CaptureModalContextValue | null>(
  null
);

export interface CaptureModalProviderProps {
  children: ReactNode;
  /** Callback when document created successfully */
  onSuccess?: (uri: string) => void;
}

export function CaptureModalProvider({
  children,
  onSuccess,
}: CaptureModalProviderProps) {
  const [open, setOpen] = useState(false);

  const openCapture = useCallback(() => setOpen(true), []);

  // 'n' global shortcut (single-key, skips when in text input)
  const shortcuts = useMemo(
    () => [
      {
        key: "n",
        action: openCapture,
      },
    ],
    [openCapture]
  );

  useKeyboardShortcuts(shortcuts);

  const value = useMemo(
    () => ({
      openCapture,
      isOpen: open,
    }),
    [openCapture, open]
  );

  return (
    <CaptureModalContext.Provider value={value}>
      {children}
      <CaptureModal onOpenChange={setOpen} onSuccess={onSuccess} open={open} />
    </CaptureModalContext.Provider>
  );
}

export function useCaptureModal(): CaptureModalContextValue {
  const context = useContext(CaptureModalContext);
  if (!context) {
    throw new Error("useCaptureModal must be used within CaptureModalProvider");
  }
  return context;
}
