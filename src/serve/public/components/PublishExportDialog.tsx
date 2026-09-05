import { Loader2Icon } from "lucide-react";
import { useRef, useState } from "react";

import type { PublishVisibility } from "../../../publish/artifact";

import { apiFetch } from "../hooks/use-api";
import {
  buildPublishExportRequest,
  downloadPublishArtifactFile,
  PUBLISH_ACCESS_OPTIONS,
  type PublishExportResponse,
} from "../lib/publish-export";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

interface PublishExportDialogProps {
  onClose: () => void;
  target: string;
  title: string;
}

/** Mount a fresh dialog for each export so access and secrets never carry over. */
export function PublishExportDialog({
  onClose,
  target,
  title,
}: PublishExportDialogProps) {
  const [visibility, setVisibility] = useState<PublishVisibility | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirmation, setPassphraseConfirmation] = useState("");
  const [audienceConfirmed, setAudienceConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exporting = useRef(false);
  const [returnFocus] = useState(() => {
    const active = document.activeElement;
    const menuTriggerId = active
      ?.closest('[role="menu"]')
      ?.getAttribute("aria-labelledby");
    const trigger = menuTriggerId
      ? document.getElementById(menuTriggerId)
      : active;
    return trigger instanceof HTMLElement ? trigger : null;
  });
  const selected = PUBLISH_ACCESS_OPTIONS.find(
    ({ value }) => value === visibility
  );
  const encryptionReady =
    visibility !== "encrypted" ||
    (passphrase.trim().length > 0 && passphrase === passphraseConfirmation);

  const handleExport = async () => {
    if (exporting.current) return;
    setError(null);
    try {
      const body = buildPublishExportRequest({
        target,
        visibility,
        passphrase,
        passphraseConfirmation,
        audienceConfirmed,
      });
      exporting.current = true;
      setBusy(true);
      const result = await apiFetch<PublishExportResponse>(
        "/api/publish/export",
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      if (result.error || !result.data) {
        setError(
          result.error ?? "The export did not return an artifact. Try again."
        );
        return;
      }
      // Refuse a mismatched response rather than downloading a broader artifact.
      if (
        result.data.artifact.spaces.length !== 1 ||
        result.data.artifact.spaces[0]?.visibility !== visibility ||
        result.data.artifact.version !== (visibility === "encrypted" ? 2 : 1)
      ) {
        setError(
          "The returned artifact does not match the reviewed access. Nothing was downloaded."
        );
        return;
      }
      downloadPublishArtifactFile(result.data);
      setPassphrase("");
      setPassphraseConfirmation("");
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to export. Try again."
      );
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !exporting.current) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto bg-card sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          if (returnFocus?.isConnected) {
            event.preventDefault();
            returnFocus.focus();
          }
        }}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Export for gno.sh</DialogTitle>
          <DialogDescription>
            Review who can read “{title}”. This downloads a local file; upload
            and publish it separately in Studio.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-2 font-medium text-sm">
            Who can read this?
          </legend>
          {PUBLISH_ACCESS_OPTIONS.map((option) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary/10 focus-within:ring-2 focus-within:ring-primary/50"
              key={option.value}
            >
              <input
                checked={visibility === option.value}
                className="mt-1 accent-primary"
                name="publish-access"
                onChange={() => {
                  setVisibility(option.value);
                  setAudienceConfirmed(false);
                  setPassphrase("");
                  setPassphraseConfirmation("");
                  setError(null);
                }}
                type="radio"
                value={option.value}
              />
              <span className="min-w-0 space-y-1">
                <span className="block font-medium text-sm">
                  {option.label}
                </span>
                <span className="block text-muted-foreground text-sm">
                  {option.audience}
                </span>
                <span className="block font-mono text-muted-foreground text-xs">
                  {option.availability}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-muted-foreground text-xs">
          Local GNO cannot check your hosted account. Studio checks plan
          availability and Egress Policy before publishing. See{" "}
          <a
            className="text-primary underline"
            href="https://gno.sh/pricing"
            rel="noopener noreferrer"
            target="_blank"
          >
            current plans
          </a>
          .
        </p>
        {visibility === "encrypted" && (
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="mb-2 font-medium text-sm">
              Local encryption
            </legend>
            <p className="text-muted-foreground text-sm">
              Your local GNO server encrypts the notes and bundled assets. The
              passphrase is never sent to gno.sh or included in the downloaded
              file. Keep it safe: lost passphrases cannot be recovered.
              Switching into or out of encrypted sharing requires a new local
              export.
            </p>
            <label className="block space-y-1 text-sm">
              <span>Passphrase</span>
              <Input
                autoComplete="new-password"
                onChange={(event) => setPassphrase(event.target.value)}
                type="password"
                value={passphrase}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Confirm passphrase</span>
              <Input
                autoComplete="new-password"
                onChange={(event) =>
                  setPassphraseConfirmation(event.target.value)
                }
                type="password"
                value={passphraseConfirmation}
              />
            </label>
            {passphraseConfirmation &&
              passphrase !== passphraseConfirmation && (
                <p className="text-destructive text-sm" role="status">
                  The passphrases do not match.
                </p>
              )}
          </fieldset>
        )}
        {selected && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              checked={audienceConfirmed}
              className="mt-1 accent-primary"
              disabled={busy}
              onChange={(event) => setAudienceConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              I reviewed the {selected.label.toLowerCase()} audience and want to
              export with this access.
            </span>
          </label>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              busy || !selected || !audienceConfirmed || !encryptionReady
            }
            onClick={() => {
              void handleExport();
            }}
          >
            {busy && <Loader2Icon className="mr-2 size-4 animate-spin" />}
            {busy ? "Exporting…" : "Download export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
