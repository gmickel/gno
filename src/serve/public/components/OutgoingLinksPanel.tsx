/**
 * OutgoingLinksPanel - Collapsible sidebar showing links FROM current document.
 *
 * Aesthetic: Scholarly Dusk - ancient manuscript margins with ink annotations.
 * - Teal primary (#4db8a8) for wiki links, old gold secondary (#d4a053) for md links
 * - Broken links shown with red/warning indicator
 * - Collapsible with elegant reveal animation
 */

import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LinkIcon,
  Loader2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Single link from the API response */
export interface OutgoingLink {
  targetRef: string;
  targetRefNorm: string;
  targetAnchor?: string;
  targetCollection?: string;
  linkType: "wiki" | "markdown";
  linkText?: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  source: string;
  /** Whether target was resolved (found in index) */
  resolved?: boolean;
  /** Resolved target document ID */
  resolvedDocid?: string;
  /** Resolved target URI */
  resolvedUri?: string;
  /** Resolved target title */
  resolvedTitle?: string;
}

/** API response shape */
interface LinksResponse {
  links: OutgoingLink[];
  meta: {
    docid: string;
    totalLinks: number;
  };
}

export interface OutgoingLinksPanelProps {
  /** Document ID to fetch links for */
  docId: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether panel starts open */
  defaultOpen?: boolean;
  /** Callback when user clicks an internal link */
  onNavigate?: (uri: string) => void;
}

/** Loading skeleton */
function LinksSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {[1, 2, 3].map((i) => (
        <div
          className="h-8 animate-pulse rounded bg-[#4db8a8]/10"
          key={i}
          style={{ animationDelay: `${i * 100}ms` }}
        />
      ))}
    </div>
  );
}

/** Empty state */
function LinksEmpty() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      <div className="flex size-9 items-center justify-center rounded-full bg-[#4db8a8]/10">
        <LinkIcon className="size-4 text-[#4db8a8]/50" />
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        No outgoing links
      </p>
    </div>
  );
}

/** Individual link item */
function LinkItem({
  link,
  onNavigate,
}: {
  link: OutgoingLink;
  onNavigate?: (uri: string) => void;
}) {
  const isWiki = link.linkType === "wiki";
  const isBroken = link.resolved === false;
  // Use resolved title if available, fall back to linkText or targetRef
  const displayText = link.resolvedTitle || link.linkText || link.targetRef;

  const handleClick = () => {
    // Only navigate if resolved and we have target URI
    if (onNavigate && link.resolvedUri) {
      onNavigate(link.resolvedUri);
    }
  };

  return (
    <button
      aria-label={`Link to ${displayText}${isBroken ? " (broken)" : ""}`}
      className={cn(
        // Base styling - scholarly marginalia feel
        "group relative flex w-full items-center gap-2.5",
        "rounded px-2.5 py-2",
        "font-mono text-xs",
        "transition-all duration-150",
        "text-left",
        // Default state
        !isBroken && [
          "hover:bg-[#4db8a8]/10",
          isWiki ? "text-[#4db8a8]" : "text-[#d4a053]",
        ],
        // Broken link state - warning indicator
        isBroken && [
          "cursor-not-allowed",
          "text-red-400/80",
          "bg-red-500/5",
          "border border-red-500/20",
        ],
        // Interactive feel for valid links
        !isBroken && "cursor-pointer hover:translate-x-0.5"
      )}
      disabled={isBroken}
      onClick={handleClick}
      type="button"
    >
      {/* Icon - different for wiki vs markdown */}
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded",
          "transition-colors duration-150",
          isBroken && "bg-red-500/10",
          !isBroken && isWiki && "bg-[#4db8a8]/15 group-hover:bg-[#4db8a8]/25",
          !isBroken && !isWiki && "bg-[#d4a053]/15 group-hover:bg-[#d4a053]/25"
        )}
      >
        {isBroken ? (
          <AlertTriangleIcon className="size-3 text-red-400" />
        ) : isWiki ? (
          <LinkIcon className="size-3" />
        ) : (
          <FileTextIcon className="size-3" />
        )}
      </span>

      {/* Link text and target with tooltip for long names */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-0 flex-1">
            <span className="block truncate">{displayText}</span>
            {link.targetAnchor && (
              <span className="block truncate text-[10px] opacity-60">
                #{link.targetAnchor}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[300px]">
          <p className="break-words">{displayText}</p>
          {link.targetAnchor && (
            <p className="text-muted-foreground text-[10px]">
              #{link.targetAnchor}
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      {/* External indicator for valid links */}
      {!isBroken && (
        <ExternalLinkIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
      )}

      {/* Broken badge */}
      {isBroken && (
        <span className="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] text-red-400">
          broken
        </span>
      )}
    </button>
  );
}

export function OutgoingLinksPanel({
  docId,
  className,
  defaultOpen = true,
  onNavigate,
}: OutgoingLinksPanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [links, setLinks] = useState<OutgoingLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch links for the document
  const fetchLinks = useCallback(async () => {
    if (!docId) {
      setLinks([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const url = `/api/doc/${encodeURIComponent(docId)}/links`;
    const { data, error: fetchError } = await apiFetch<LinksResponse>(url);

    if (fetchError || !data) {
      setError(fetchError ?? "Failed to load links");
      setLoading(false);
      return;
    }

    setLinks(data.links);
    setLoading(false);
  }, [docId]);

  // Fetch on mount and when docId changes
  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  // Count broken links
  const brokenCount = links.filter((l) => l.resolved === false).length;

  return (
    <Collapsible
      className={cn(
        // Container styling - dark manuscript edge
        "border-border/40 border-l",
        "bg-gradient-to-b from-[#050505] to-[#0a0a0a]",
        className
      )}
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      {/* Header trigger */}
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 px-3 py-2.5",
          "transition-colors duration-150",
          "hover:bg-[#4db8a8]/5"
        )}
      >
        {/* Chevron */}
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60",
            "transition-transform duration-200",
            !isOpen && "-rotate-90"
          )}
        />

        {/* Title */}
        <span className="flex-1 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Outgoing Links
        </span>

        {/* Count badges */}
        {!loading && links.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="rounded bg-[#4db8a8]/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#4db8a8]">
              {links.length}
            </span>
            {brokenCount > 0 && (
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-red-400">
                {brokenCount}
              </span>
            )}
          </div>
        )}

        {/* Loading indicator in header */}
        {loading && (
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground/50" />
        )}
      </CollapsibleTrigger>

      {/* Content */}
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down">
        {loading && <LinksSkeleton />}

        {!loading && error && (
          <div className="p-3 text-center">
            <p className="font-mono text-destructive text-xs">{error}</p>
            <button
              className="mt-1.5 font-mono text-[#4db8a8] text-xs underline-offset-2 hover:underline"
              onClick={() => void fetchLinks()}
              type="button"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && links.length === 0 && <LinksEmpty />}

        {!loading && !error && links.length > 0 && (
          <div className="space-y-0.5 p-2">
            {links.map((link, idx) => (
              <LinkItem
                // Use combination of targetRef, startLine, startCol for uniqueness
                key={`${link.targetRef}-${link.startLine}-${link.startCol}-${idx}`}
                link={link}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
