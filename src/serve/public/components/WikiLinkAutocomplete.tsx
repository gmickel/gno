/**
 * WikiLinkAutocomplete - Dropdown autocomplete for wiki-style [[link]] syntax.
 *
 * Aesthetic: "Scholarly Dusk" with vintage card catalog styling
 * - Brass/old gold accents reminiscent of library fixtures
 * - Teal primary for interactive highlights
 * - Monospace typography for document references
 * - Embossed shadows evoking index cards
 *
 * Triggers when user types [[, shows fuzzy-matched doc titles,
 * supports keyboard navigation, and offers "Create new" for non-existent targets.
 */

import { FilePlusIcon, FileTextIcon, LinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { cn } from "../lib/utils";

/** Document info for autocomplete */
export interface WikiLinkDoc {
  title: string;
  uri: string;
  docid: string;
  collection?: string;
}

export interface WikiLinkAutocompleteProps {
  /** Whether dropdown is visible */
  isOpen: boolean;
  /** Screen position for dropdown */
  position: { x: number; y: number };
  /** Text after [[ trigger */
  searchQuery: string;
  /** Available documents to search */
  docs: WikiLinkDoc[];
  /** Called when user selects a document */
  onSelect: (title: string, displayText?: string) => void;
  /** Called when user wants to create new note */
  onCreateNew?: (title: string) => void;
  /** Called when dropdown should close */
  onDismiss: () => void;
  /** Active index for keyboard nav (controlled externally) */
  activeIndex?: number;
  /** Callback when active index changes */
  onActiveIndexChange?: (index: number) => void;
  /** Additional classes */
  className?: string;
}

/** Maximum results to display */
const MAX_RESULTS = 8;

/**
 * Fuzzy match score - returns -1 if no match, else score (higher = better)
 * Prefers: exact match > prefix > word boundary > substring > scattered
 */
function fuzzyScore(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact match
  if (lowerText === lowerQuery) return 1000;

  // Prefix match
  if (lowerText.startsWith(lowerQuery))
    return 900 + (query.length / text.length) * 50;

  // Contains as substring
  const substringIdx = lowerText.indexOf(lowerQuery);
  if (substringIdx !== -1) {
    // Bonus for word boundary
    const previousChar = substringIdx > 0 ? text.charAt(substringIdx - 1) : "";
    if (substringIdx === 0 || /\W/.test(previousChar)) {
      return 800 + (query.length / text.length) * 50;
    }
    return 700 + (query.length / text.length) * 50;
  }

  // Scattered character match
  let score = 0;
  let textIdx = 0;
  let consecutiveBonus = 0;

  for (const char of lowerQuery) {
    const foundIdx = lowerText.indexOf(char, textIdx);
    if (foundIdx === -1) return -1; // No match

    // Consecutive chars get bonus
    if (foundIdx === textIdx) {
      consecutiveBonus += 10;
    } else {
      consecutiveBonus = 0;
    }

    // Word boundary bonus
    const previousChar = foundIdx > 0 ? text.charAt(foundIdx - 1) : "";
    if (foundIdx === 0 || /\W/.test(previousChar)) {
      score += 20;
    }

    score += 10 + consecutiveBonus;
    textIdx = foundIdx + 1;
  }

  return score;
}

/**
 * Get indices of matching characters for highlighting
 */
function getMatchIndices(text: string, query: string): number[] {
  const indices: number[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Check for substring match first
  const substringIdx = lowerText.indexOf(lowerQuery);
  if (substringIdx !== -1) {
    for (let i = 0; i < query.length; i++) {
      indices.push(substringIdx + i);
    }
    return indices;
  }

  // Fall back to scattered match
  let textIdx = 0;
  for (const char of lowerQuery) {
    const foundIdx = lowerText.indexOf(char, textIdx);
    if (foundIdx !== -1) {
      indices.push(foundIdx);
      textIdx = foundIdx + 1;
    }
  }

  return indices;
}

/** Highlight component for matched characters */
function HighlightedText({
  text,
  matchIndices,
}: {
  text: string;
  matchIndices: number[];
}) {
  if (matchIndices.length === 0) {
    return <span>{text}</span>;
  }

  const indexSet = new Set(matchIndices);
  const parts: React.ReactNode[] = [];
  let currentRun = "";
  let isHighlighted = false;

  for (let i = 0; i < text.length; i++) {
    const currentChar = text.charAt(i);
    const charIsHighlighted = indexSet.has(i);

    if (charIsHighlighted !== isHighlighted) {
      // Flush current run
      if (currentRun) {
        parts.push(
          isHighlighted ? (
            <mark
              className="rounded-sm bg-primary/25 px-0.5 text-primary"
              key={`h-${i}`}
            >
              {currentRun}
            </mark>
          ) : (
            <span key={`t-${i}`}>{currentRun}</span>
          )
        );
      }
      currentRun = currentChar;
      isHighlighted = charIsHighlighted;
    } else {
      currentRun += currentChar;
    }
  }

  // Flush final run
  if (currentRun) {
    parts.push(
      isHighlighted ? (
        <mark
          className="rounded-sm bg-primary/25 px-0.5 text-primary"
          key="h-final"
        >
          {currentRun}
        </mark>
      ) : (
        <span key="t-final">{currentRun}</span>
      )
    );
  }

  return <>{parts}</>;
}

export function WikiLinkAutocomplete({
  isOpen,
  position,
  searchQuery,
  docs,
  onSelect,
  onCreateNew,
  onDismiss,
  activeIndex = -1,
  onActiveIndexChange,
  className,
}: WikiLinkAutocompleteProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = "wikilink-autocomplete-listbox";

  // Filter and score docs
  const filteredDocs = useMemo(() => {
    if (!searchQuery.trim()) {
      return docs.slice(0, MAX_RESULTS).map((doc) => ({
        doc,
        score: 0,
        matchIndices: [] as number[],
      }));
    }

    const scored = docs
      .map((doc) => ({
        doc,
        score: fuzzyScore(doc.title, searchQuery),
        matchIndices: getMatchIndices(doc.title, searchQuery),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    return scored;
  }, [docs, searchQuery]);

  // Check if exact match exists
  const hasExactMatch = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return docs.some((doc) => doc.title.toLowerCase() === query);
  }, [docs, searchQuery]);

  // Show create option if query has content and no exact match
  const showCreateOption =
    searchQuery.trim().length > 0 && !hasExactMatch && onCreateNew;

  // Total selectable items (docs + create option)
  const totalItems = filteredDocs.length + (showCreateOption ? 1 : 0);
  const createOptionIndex = filteredDocs.length;

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onActiveIndexChange?.(
            activeIndex < totalItems - 1 ? activeIndex + 1 : 0
          );
          break;

        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onActiveIndexChange?.(
            activeIndex > 0 ? activeIndex - 1 : totalItems - 1
          );
          break;

        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (activeIndex >= 0 && activeIndex < filteredDocs.length) {
            const activeDoc = filteredDocs.at(activeIndex);
            if (activeDoc) {
              onSelect(activeDoc.doc.title);
            }
          } else if (activeIndex === createOptionIndex && showCreateOption) {
            onCreateNew?.(searchQuery.trim());
          } else if (filteredDocs.length > 0) {
            // Default to first result if nothing selected
            const firstDoc = filteredDocs.at(0);
            if (firstDoc) {
              onSelect(firstDoc.doc.title);
            }
          } else if (showCreateOption) {
            onCreateNew?.(searchQuery.trim());
          }
          break;

        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
          break;

        case "Tab":
          // Allow tab to dismiss
          onDismiss();
          break;
      }
    },
    [
      isOpen,
      activeIndex,
      totalItems,
      filteredDocs,
      createOptionIndex,
      showCreateOption,
      searchQuery,
      onActiveIndexChange,
      onSelect,
      onCreateNew,
      onDismiss,
    ]
  );

  // Attach keyboard listener
  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown, true);
      return () => document.removeEventListener("keydown", handleKeyDown, true);
    }
  }, [isOpen, handleKeyDown]);

  // Scroll active option into view
  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const optionEl = listRef.current.querySelector(
        `[data-index="${activeIndex}"]`
      );
      optionEl?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  // Click outside to dismiss
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current && !listRef.current.contains(target)) {
        onDismiss();
      }
    };

    // Delay to avoid immediate dismissal
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onDismiss]);

  if (!isOpen) return null;

  const hasResults = filteredDocs.length > 0 || showCreateOption;

  return (
    <div
      className={cn(
        // Positioning
        "fixed z-[60]",
        // Fade in animation
        "animate-fade-in",
        className
      )}
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      <ul
        aria-label="Wiki link suggestions"
        className={cn(
          // Container - vintage card catalog drawer aesthetic
          "min-w-[280px] max-w-[400px]",
          "max-h-[320px] overflow-auto",
          "rounded-md border",
          // Scholarly Dusk palette
          "border-[hsl(var(--secondary)/0.3)] bg-[hsl(220,15%,10%)]",
          // Embossed shadow like drawer pulled out
          "shadow-[0_4px_20px_-4px_rgba(0,0,0,0.5),0_0_0_1px_hsl(var(--secondary)/0.1)]",
          // Inner glow at top
          "before:absolute before:inset-x-0 before:top-0 before:h-8 before:bg-gradient-to-b before:from-[hsl(var(--secondary)/0.05)] before:to-transparent before:pointer-events-none"
        )}
        id={listboxId}
        ref={listRef}
        role="listbox"
      >
        {/* Header bar - like drawer label */}
        <li
          aria-hidden="true"
          className={cn(
            "sticky top-0 z-10",
            "flex items-center gap-2 px-3 py-2",
            "border-b border-[hsl(var(--secondary)/0.15)]",
            "bg-[hsl(220,15%,12%)]",
            "backdrop-blur-sm"
          )}
        >
          <LinkIcon className="size-3.5 text-[hsl(var(--secondary)/0.6)]" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[hsl(var(--secondary)/0.5)]">
            Link to document
          </span>
          {searchQuery && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/40">
              [[{searchQuery}
            </span>
          )}
        </li>

        {/* Results */}
        {filteredDocs.map((item, idx) => (
          <li
            aria-selected={activeIndex === idx}
            className={cn(
              // Base option style
              "flex cursor-pointer items-start gap-3",
              "px-3 py-2.5",
              "transition-all duration-100",
              // Border between items
              "border-b border-[hsl(var(--secondary)/0.08)] last:border-b-0",
              // Hover/active states
              "hover:bg-[hsl(var(--primary)/0.08)]",
              activeIndex === idx && [
                "bg-[hsl(var(--primary)/0.12)]",
                // Left accent bar when active
                "relative before:absolute before:left-0 before:top-1 before:bottom-1",
                "before:w-0.5 before:rounded-r before:bg-primary",
              ]
            )}
            data-index={idx}
            key={item.doc.docid}
            onClick={() => onSelect(item.doc.title)}
            onMouseEnter={() => onActiveIndexChange?.(idx)}
            role="option"
          >
            {/* Document icon */}
            <FileTextIcon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                activeIndex === idx
                  ? "text-primary"
                  : "text-[hsl(var(--secondary)/0.4)]"
              )}
            />

            {/* Content */}
            <div className="min-w-0 flex-1">
              {/* Title with highlighting */}
              <div
                className={cn(
                  "truncate font-mono text-sm",
                  activeIndex === idx ? "text-primary" : "text-foreground/90"
                )}
              >
                <HighlightedText
                  matchIndices={item.matchIndices}
                  text={item.doc.title}
                />
              </div>

              {/* Collection badge */}
              {item.doc.collection && (
                <div className="mt-1 flex items-center gap-1">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      "rounded px-1.5 py-0.5",
                      "bg-[hsl(var(--secondary)/0.1)]",
                      "font-mono text-[10px] text-[hsl(var(--secondary)/0.6)]",
                      "border border-[hsl(var(--secondary)/0.15)]"
                    )}
                  >
                    {item.doc.collection}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}

        {/* Create new option */}
        {showCreateOption && (
          <li
            aria-selected={activeIndex === createOptionIndex}
            className={cn(
              // Distinct styling for create action
              "flex cursor-pointer items-center gap-3",
              "px-3 py-2.5",
              "transition-all duration-100",
              // Dashed top border for separation
              "border-t border-dashed border-[hsl(var(--secondary)/0.2)]",
              // Different background tint
              "bg-[hsl(var(--secondary)/0.03)]",
              // Hover/active
              "hover:bg-[hsl(var(--secondary)/0.08)]",
              activeIndex === createOptionIndex && [
                "bg-[hsl(var(--secondary)/0.12)]",
                "relative before:absolute before:left-0 before:top-1 before:bottom-1",
                "before:w-0.5 before:rounded-r before:bg-secondary",
              ]
            )}
            data-index={createOptionIndex}
            onClick={() => onCreateNew?.(searchQuery.trim())}
            onMouseEnter={() => onActiveIndexChange?.(createOptionIndex)}
            role="option"
          >
            <FilePlusIcon
              className={cn(
                "size-4 shrink-0",
                activeIndex === createOptionIndex
                  ? "text-secondary"
                  : "text-[hsl(var(--secondary)/0.5)]"
              )}
            />
            <span
              className={cn(
                "font-mono text-sm",
                activeIndex === createOptionIndex
                  ? "text-secondary"
                  : "text-[hsl(var(--secondary)/0.7)]"
              )}
            >
              Create{" "}
              <span className="rounded bg-[hsl(var(--secondary)/0.15)] px-1.5 py-0.5 text-foreground/80">
                [[{searchQuery.trim()}]]
              </span>
            </span>
          </li>
        )}

        {/* Empty state */}
        {!hasResults && (
          <li
            aria-disabled="true"
            className="px-3 py-6 text-center"
            role="option"
          >
            <FileTextIcon className="mx-auto mb-2 size-5 text-muted-foreground/30" />
            <p className="font-mono text-xs text-muted-foreground/50">
              No matching documents
            </p>
            {searchQuery && (
              <p className="mt-1 text-[10px] text-muted-foreground/30">
                Type more to search or clear to browse
              </p>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}
