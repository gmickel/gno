import {
  AlertCircleIcon,
  CheckCircle2Icon,
  LinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useState } from "react";

import { GnoLogo } from "../components/GnoLogo";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  approveClipperPair,
  ClipperApprovalError,
  type ClipperApproval,
} from "../lib/clipper-approval";

interface ClipperPairingProps {
  pairId: string | null;
}

type PairingState = "ready" | "approving" | "approved" | "terminal";

const terminalCodes = new Set([
  "CLIPPER_PAIR_EXPIRED",
  "CLIPPER_PAIR_ALREADY_USED",
  "CLIPPER_PAIR_NOT_FOUND",
]);

export default function ClipperPairing({ pairId }: ClipperPairingProps) {
  const [activePairId, setActivePairId] = useState(pairId);
  const [pairingCode, setPairingCode] = useState("");
  const [state, setState] = useState<PairingState>(
    pairId === null ? "terminal" : "ready"
  );
  const [approval, setApproval] = useState<ClipperApproval | null>(null);
  const [error, setError] = useState<string | null>(
    pairId === null
      ? "This pairing link is invalid. Start pairing again from the extension."
      : null
  );

  const clearSensitiveState = () => {
    setPairingCode("");
    setActivePairId(null);
  };

  const approve = async () => {
    if (activePairId === null || !/^\d{8}$/u.test(pairingCode)) return;
    setState("approving");
    setError(null);
    try {
      const result = await approveClipperPair(activePairId, pairingCode);
      clearSensitiveState();
      setApproval(result);
      setState("approved");
    } catch (cause) {
      const parsed =
        cause instanceof ClipperApprovalError
          ? cause
          : new ClipperApprovalError(
              "CLIPPER_NETWORK",
              "Could not reach the local GNO gateway. Keep the extension open and retry.",
              true
            );
      setError(parsed.message);
      if (terminalCodes.has(parsed.code) || !parsed.retryable) {
        clearSensitiveState();
        setState("terminal");
      } else {
        setPairingCode("");
        setState("ready");
      }
    }
  };

  const cancel = () => {
    clearSensitiveState();
    setError("Pairing cancelled. Start again from the extension when ready.");
    setState("terminal");
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,oklch(0.68_0.11_55/0.12),transparent_42%),radial-gradient(circle_at_bottom_right,oklch(0.52_0.08_245/0.10),transparent_48%)]" />
      <Card className="relative w-full max-w-lg border-border/70 shadow-2xl">
        <CardHeader>
          <div className="mb-3 flex items-center gap-3 text-primary">
            <GnoLogo className="size-9" />
            <span className="font-mono text-xs tracking-[0.2em] uppercase">
              Local approval
            </span>
          </div>
          <CardTitle className="font-semibold text-2xl">
            Pair the GNO browser clipper
          </CardTitle>
          <CardDescription className="leading-6">
            This extension may send only content you explicitly capture into
            this local GNO. Access expires within 30 days and can be revoked
            from the extension.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {state === "ready" || state === "approving" ? (
            <>
              <div className="rounded-lg border border-border/60 bg-muted/25 p-4 text-sm">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <LinkIcon className="size-4 text-primary" />
                  Confirm this browser
                </div>
                <p className="text-muted-foreground">
                  Enter the eight-digit code shown in the extension. GNO never
                  gives this page the extension grant.
                </p>
              </div>
              <label className="block space-y-2">
                <span className="font-medium text-sm">Pairing code</span>
                <Input
                  aria-label="Pairing code"
                  autoComplete="off"
                  autoFocus
                  className="h-12 font-mono text-lg tracking-[0.3em]"
                  disabled={state === "approving"}
                  inputMode="numeric"
                  maxLength={8}
                  onChange={(event) =>
                    setPairingCode(
                      event.currentTarget.value
                        .replaceAll(/\D/gu, "")
                        .slice(0, 8)
                    )
                  }
                  pattern="[0-9]{8}"
                  placeholder="00000000"
                  value={pairingCode}
                />
              </label>
            </>
          ) : null}

          {approval ? (
            <div
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4"
              role="status"
            >
              <div className="mb-2 flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
                <CheckCircle2Icon className="size-5" />
                Browser paired
              </div>
              <p className="break-all text-muted-foreground text-sm">
                {approval.origin}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                Expires {new Date(approval.expiresAt).toLocaleString()}
              </p>
            </div>
          ) : null}

          {error ? (
            <div
              className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
              role="alert"
            >
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>{error}</span>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="justify-between gap-3">
          {state === "ready" || state === "approving" ? (
            <>
              <Button
                disabled={state === "approving"}
                onClick={cancel}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={
                  state === "approving" || !/^\d{8}$/u.test(pairingCode)
                }
                onClick={() => void approve()}
                type="button"
              >
                {state === "approving" ? (
                  <Loader2Icon className="animate-spin" />
                ) : null}
                Approve extension
              </Button>
            </>
          ) : (
            <Button asChild className="ml-auto" variant="outline">
              <a href="/">Back to GNO</a>
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  );
}
