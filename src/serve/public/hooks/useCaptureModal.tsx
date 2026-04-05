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

export interface CaptureModalOpenOptions {
  draftTitle?: string;
  defaultCollection?: string;
  defaultFolderPath?: string;
  presetId?: string;
}

interface CaptureModalContextValue {
  /** Open the capture modal */
  openCapture: (options?: string | CaptureModalOpenOptions) => void;
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
  const [draftTitle, setDraftTitle] = useState("");
  const [defaultCollection, setDefaultCollection] = useState("");
  const [defaultFolderPath, setDefaultFolderPath] = useState("");
  const [presetId, setPresetId] = useState("");

  const openCapture = useCallback(
    (options?: string | CaptureModalOpenOptions) => {
      if (typeof options === "string") {
        setDraftTitle(options);
        setDefaultCollection("");
        setDefaultFolderPath("");
        setPresetId("");
      } else {
        setDraftTitle(options?.draftTitle ?? "");
        setDefaultCollection(options?.defaultCollection ?? "");
        setDefaultFolderPath(options?.defaultFolderPath ?? "");
        setPresetId(options?.presetId ?? "");
      }
      setOpen(true);
    },
    []
  );

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
      <CaptureModal
        defaultCollection={defaultCollection}
        defaultFolderPath={defaultFolderPath}
        draftTitle={draftTitle}
        onOpenChange={setOpen}
        onSuccess={onSuccess}
        open={open}
        presetId={presetId}
      />
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
