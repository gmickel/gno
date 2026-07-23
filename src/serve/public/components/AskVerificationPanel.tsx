import { AlertTriangle, CheckCircle2, CircleHelp, ShieldX } from "lucide-react";

import type { AskResult } from "../../../pipeline/types";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

export type AskVerification = NonNullable<AskResult["verification"]>;

interface AskVerificationPanelProps {
  navigate: (to: string) => void;
  verification: AskVerification;
}

const STATUS_PRESENTATION = {
  supported: {
    label: "supported",
    icon: CheckCircle2,
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  contradicted: {
    label: "contradicted",
    icon: ShieldX,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  insufficient: {
    label: "insufficient",
    icon: AlertTriangle,
    className: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  },
  uncertain: {
    label: "uncertain",
    icon: CircleHelp,
    className: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  },
} as const;

const evidenceLabel = (uri: string, startLine: number, endLine: number) =>
  `${uri}:L${startLine}${startLine === endLine ? "" : `-L${endLine}`}`;

export function AskVerificationPanel({
  navigate,
  verification,
}: AskVerificationPanelProps) {
  const { claims, capsule, semantic } = verification;
  const degradedCapabilities = Object.entries(
    capsule.retrieval.capabilityStates
  ).filter(([, state]) => state.requested && state.outcome !== "used");
  const gaps = capsule.coverage.gaps;

  return (
    <details className="group rounded-lg border border-border/50 bg-card/55">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">
              {claims.answerStatus === "verified"
                ? "All claims verified"
                : "Answer withheld"}
            </span>
            <Badge
              className="font-mono text-[9px]"
              variant={
                claims.answerStatus === "verified" ? "default" : "outline"
              }
            >
              {claims.coverage.supportedClaims}/{claims.coverage.totalClaims}{" "}
              supported
            </Badge>
          </div>
          <p className="mt-1 text-muted-foreground text-xs">
            {claims.abstentionReason ??
              `${claims.coverage.supportedRatio * 100}% support coverage`}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground group-open:hidden">
          details
        </span>
      </summary>

      <div className="space-y-4 border-border/40 border-t px-4 py-4">
        <div className="flex flex-wrap gap-2">
          <Badge className="font-mono text-[9px]" variant="outline">
            semantic: {semantic.status}/{semantic.reason}
          </Badge>
          {degradedCapabilities.map(([name, state]) => (
            <Badge
              className="font-mono text-[9px]"
              key={name}
              variant="outline"
            >
              {name}: {state.outcome}
              {state.fallbackReasons.length > 0
                ? ` (${state.fallbackReasons.join(", ")})`
                : ""}
            </Badge>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-muted-foreground sm:grid-cols-4">
          <span>{claims.coverage.supportedClaims} supported</span>
          <span>{claims.coverage.contradictedClaims} contradicted</span>
          <span>{claims.coverage.insufficientClaims} insufficient</span>
          <span>{claims.coverage.uncertainClaims} uncertain</span>
        </div>

        <div className="space-y-2">
          {claims.claims.map((claim) => {
            const presentation = STATUS_PRESENTATION[claim.status];
            const StatusIcon = presentation.icon;
            return (
              <details
                className="rounded-md border border-border/35 bg-background/20"
                key={claim.claimId}
              >
                <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2">
                  <StatusIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 text-xs">{claim.text}</span>
                  <Badge
                    className={cn(
                      "shrink-0 font-mono text-[9px]",
                      presentation.className
                    )}
                    variant="outline"
                  >
                    {presentation.label}
                  </Badge>
                </summary>
                <div className="space-y-2 border-border/30 border-t px-3 py-2">
                  {claim.evidence.length > 0 ? (
                    claim.evidence.map((evidence) => (
                      <button
                        className="block w-full truncate text-left font-mono text-[10px] text-primary hover:underline"
                        key={evidence.evidenceId}
                        onClick={() =>
                          navigate(
                            `/doc?uri=${encodeURIComponent(evidence.uri)}`
                          )
                        }
                        title={evidenceLabel(
                          evidence.uri,
                          evidence.startLine,
                          evidence.endLine
                        )}
                        type="button"
                      >
                        {evidenceLabel(
                          evidence.uri,
                          evidence.startLine,
                          evidence.endLine
                        )}
                      </button>
                    ))
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      No retained evidence span.
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {claim.rationaleCode}
                    {claim.confidence === null
                      ? ""
                      : ` · confidence ${claim.confidence.toFixed(2)}`}
                  </p>
                </div>
              </details>
            );
          })}
        </div>

        {(capsule.coverage.unresolvedFacets.length > 0 || gaps.length > 0) && (
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <p className="font-medium text-amber-200 text-xs">Evidence gaps</p>
            <ul className="mt-1 space-y-1 font-mono text-[10px] text-muted-foreground">
              {capsule.coverage.unresolvedFacets.map((facet) => (
                <li key={`facet:${facet}`}>unresolved facet: {facet}</li>
              ))}
              {gaps.map((gap) => (
                <li key={`${gap.facet}:${gap.code}`}>
                  {gap.facet}: {gap.code}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
