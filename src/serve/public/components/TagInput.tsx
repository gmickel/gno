/**
 * TagInput - Chip-based combobox for tag entry with autocomplete.
 *
 * Aesthetic: Vintage specimen labels / card catalog tabs
 * - Tags styled as library index cards with subtle brass accents
 * - Monospace typography for technical/archival feel
 * - Hierarchical tags shown with subtle prefix grouping
 */

import { TagIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch } from "../hooks/use-api";
import { cn } from "../lib/utils";

/** Tag suggestion from API */
interface TagSuggestion {
  tag: string;
  count: number;
}

interface TagsResponse {
  tags: TagSuggestion[];
  meta: { total: number };
}

export interface TagInputProps {
  /** Current tags */
  value: string[];
  /** Callback when tags change */
  onChange: (tags: string[]) => void;
  /** Disabled state */
  disabled?: boolean;
  /** Additional classes */
  className?: string;
  /** Input placeholder */
  placeholder?: string;
  /** Aria label for the input */
  "aria-label"?: string;
}

// Tag grammar validation (matches src/core/tags.ts)
const SEGMENT_REGEX = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}\-.]*$/u;

function normalizeTag(tag: string): string {
  return tag.trim().normalize("NFC").toLowerCase();
}

function validateTag(tag: string): boolean {
  if (tag.length === 0) return false;
  if (tag.startsWith("/") || tag.endsWith("/")) return false;

  const segments = tag.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return false;
    if (!SEGMENT_REGEX.test(segment)) return false;
  }
  return true;
}

/** Flattened option for rendering and keyboard nav */
interface FlatOption {
  tag: string;
  count: number;
  prefix: string;
  displayName: string;
  isFirstInGroup: boolean;
}

/** Build flat list with grouping metadata */
function flattenSuggestions(suggestions: TagSuggestion[]): FlatOption[] {
  // Group by prefix
  const groups = new Map<string, TagSuggestion[]>();
  for (const s of suggestions) {
    const slashIdx = s.tag.indexOf("/");
    const prefix = slashIdx > 0 ? s.tag.slice(0, slashIdx) : "";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(s);
  }

  // Flatten with stable ordering: root first, then prefixes alphabetically
  const flat: FlatOption[] = [];
  const prefixes = Array.from(groups.keys()).sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  for (const prefix of prefixes) {
    const groupTags = groups.get(prefix)!;
    for (let i = 0; i < groupTags.length; i++) {
      const s = groupTags[i];
      flat.push({
        tag: s.tag,
        count: s.count,
        prefix,
        displayName: prefix ? s.tag.slice(prefix.length + 1) : s.tag,
        isFirstInGroup: i === 0,
      });
    }
  }

  return flat;
}

export function TagInput({
  value,
  onChange,
  disabled = false,
  className,
  placeholder = "Add tags...",
  "aria-label": ariaLabel = "Tag input",
}: TagInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceId = useId();

  // Input state
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);

  // Live region for screen reader announcements
  const [announcement, setAnnouncement] = useState("");

  // Request sequencing to prevent race conditions
  const requestSeqRef = useRef(0);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const listboxId = `${instanceId}-listbox`;
  const getOptionId = (index: number) => `${instanceId}-option-${index}`;

  // Fetch suggestions with debounce and sequencing
  const fetchSuggestions = useCallback(
    async (prefix: string, seq: number) => {
      if (prefix.length === 0) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }

      setIsLoading(true);

      // Normalize prefix for lookup (strip trailing slash for prefix query)
      const queryPrefix = normalizeTag(prefix);
      const { data, error: fetchError } = await apiFetch<TagsResponse>(
        `/api/tags?prefix=${encodeURIComponent(queryPrefix)}`
      );

      // Ignore stale responses
      if (seq !== requestSeqRef.current) return;

      setIsLoading(false);

      if (fetchError || !data) {
        setSuggestions([]);
        return;
      }

      // Filter out already-selected tags
      const filtered = data.tags.filter((s) => !value.includes(s.tag));
      setSuggestions(filtered);
      setIsOpen(filtered.length > 0);
      setActiveIndex(-1);

      // Announce results
      if (filtered.length > 0) {
        setAnnouncement(`${filtered.length} tag suggestions available`);
      }
    },
    [value]
  );

  // Debounce input changes with sequencing
  useEffect(() => {
    if (fetchTimeoutRef.current) {
      clearTimeout(fetchTimeoutRef.current);
    }

    if (inputValue.length > 0) {
      const seq = ++requestSeqRef.current;
      fetchTimeoutRef.current = setTimeout(() => {
        void fetchSuggestions(inputValue, seq);
      }, 200);
    } else {
      // Increment seq so stale in-flight responses are ignored
      ++requestSeqRef.current;
      setSuggestions([]);
      setIsOpen(false);
    }

    return () => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }
    };
  }, [inputValue, fetchSuggestions]);

  // Flatten suggestions for keyboard navigation
  const flatOptions = useMemo(
    () => flattenSuggestions(suggestions),
    [suggestions]
  );

  // Add a tag
  const addTag = useCallback(
    (tag: string) => {
      const normalized = normalizeTag(tag);

      if (!normalized) {
        setError("Tag cannot be empty");
        return false;
      }

      if (!validateTag(normalized)) {
        setError(
          "Invalid: use lowercase, alphanumeric, hyphens, dots, slashes"
        );
        return false;
      }

      if (value.includes(normalized)) {
        setError("Tag already added");
        return false;
      }

      onChange([...value, normalized]);
      setInputValue("");
      setError(null);
      setSuggestions([]);
      setIsOpen(false);
      setAnnouncement(`Added tag: ${normalized}`);
      return true;
    },
    [value, onChange]
  );

  // Remove a tag
  const removeTag = useCallback(
    (tag: string) => {
      onChange(value.filter((t) => t !== tag));
      setAnnouncement(`Removed tag: ${tag}`);
      inputRef.current?.focus();
    },
    [value, onChange]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (!isOpen && flatOptions.length > 0) {
            setIsOpen(true);
          }
          setActiveIndex((prev) =>
            prev < flatOptions.length - 1 ? prev + 1 : prev
          );
          break;

        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : -1));
          break;

        case "Enter":
          e.preventDefault();
          if (activeIndex >= 0 && flatOptions[activeIndex]) {
            addTag(flatOptions[activeIndex].tag);
          } else if (inputValue) {
            addTag(inputValue);
          }
          break;

        case "Escape":
          e.preventDefault();
          if (isOpen) {
            setIsOpen(false);
            setActiveIndex(-1);
          } else {
            setInputValue("");
            setError(null);
          }
          break;

        case "Backspace":
          if (inputValue === "" && value.length > 0) {
            e.preventDefault();
            removeTag(value[value.length - 1]);
          }
          break;
      }
    },
    [isOpen, flatOptions, activeIndex, inputValue, value, addTag, removeTag]
  );

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll active option into view using getElementById
  useEffect(() => {
    if (activeIndex >= 0) {
      const optionEl = document.getElementById(getOptionId(activeIndex));
      optionEl?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, getOptionId]);

  // Track current group for header rendering
  let currentPrefix: string | null = null;

  return (
    <div className={cn("relative", className)} ref={containerRef}>
      {/* Tag chips container with input */}
      <div
        className={cn(
          // Base container - card catalog drawer aesthetic
          "flex min-h-[42px] flex-wrap items-center gap-1.5",
          "rounded-md border bg-card/50 px-2.5 py-1.5",
          "transition-all duration-200",
          // Border states - use border color only, no ring to avoid double border
          "border-border/60 hover:border-border",
          "focus-within:border-primary",
          // Error state
          error && "border-destructive",
          // Disabled
          disabled && "cursor-not-allowed opacity-50"
        )}
        onClick={() => inputRef.current?.focus()}
        role="presentation"
      >
        {/* Tag chips - specimen label style */}
        {value.map((tag) => (
          <span
            className={cn(
              // Card catalog tab aesthetic
              "group inline-flex items-center gap-1",
              "rounded border border-border/50 bg-muted/50",
              "px-2 py-0.5 font-mono text-xs",
              // Subtle brass/gold left accent
              "relative pl-3",
              "before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1",
              "before:rounded-l before:bg-secondary/40",
              // Text
              "text-foreground/90",
              // Hover lift
              "transition-all duration-150",
              "hover:border-primary/30 hover:bg-muted/70 hover:shadow-sm"
            )}
            key={tag}
          >
            <span className="max-w-[200px] truncate">{tag}</span>
            <button
              aria-label={`Remove ${tag}`}
              className={cn(
                "ml-0.5 rounded-sm p-0.5 opacity-60",
                "transition-all duration-150",
                "hover:bg-destructive/20 hover:text-destructive hover:opacity-100",
                "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              )}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}

        {/* Input field */}
        <div className="relative flex min-w-[120px] flex-1 items-center gap-1.5">
          {value.length === 0 && (
            <TagIcon className="size-3.5 text-muted-foreground/50" />
          )}
          <input
            aria-activedescendant={
              activeIndex >= 0 ? getOptionId(activeIndex) : undefined
            }
            aria-autocomplete="list"
            aria-controls={isOpen ? listboxId : undefined}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-invalid={!!error}
            aria-label={ariaLabel}
            autoComplete="off"
            className={cn(
              "flex-1 bg-transparent font-mono text-sm",
              "placeholder:text-muted-foreground/50",
              "outline-none",
              disabled && "cursor-not-allowed"
            )}
            disabled={disabled}
            onChange={(e) => {
              setInputValue(e.target.value);
              setError(null);
            }}
            onFocus={() => {
              if (inputValue.length > 0 && flatOptions.length > 0) {
                setIsOpen(true);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder={value.length === 0 ? placeholder : ""}
            ref={inputRef}
            role="combobox"
            type="text"
            value={inputValue}
          />

          {/* Loading indicator */}
          {isLoading && (
            <div className="size-3 animate-spin rounded-full border border-primary/30 border-t-primary" />
          )}
        </div>
      </div>

      {/* Error message */}
      {error && (
        <p
          className="mt-1.5 animate-fade-in font-mono text-destructive text-xs"
          role="alert"
        >
          {error}
        </p>
      )}

      {/* Autocomplete dropdown - vintage index card drawer */}
      {isOpen && flatOptions.length > 0 && (
        <ul
          className={cn(
            // Dropdown container
            "absolute z-50 mt-1 w-full",
            "max-h-[240px] overflow-auto",
            "rounded-md border border-border/60 bg-popover",
            "shadow-lg shadow-black/20",
            // Fade in animation
            "animate-fade-in"
          )}
          id={listboxId}
          role="listbox"
        >
          {flatOptions.map((opt, idx) => {
            // Show group header when prefix changes
            const showHeader = opt.prefix && opt.prefix !== currentPrefix;
            currentPrefix = opt.prefix;

            return (
              <li key={opt.tag} role="presentation">
                {/* Group header for hierarchical tags */}
                {showHeader && (
                  <div className="sticky top-0 border-border/30 border-b bg-muted/80 px-2.5 py-1 font-mono text-[10px] text-muted-foreground uppercase tracking-wider backdrop-blur-sm">
                    {opt.prefix}/
                  </div>
                )}

                {/* Option */}
                <div
                  aria-selected={activeIndex === idx}
                  className={cn(
                    // Base option style
                    "flex cursor-pointer items-center justify-between gap-2",
                    "px-2.5 py-2",
                    "transition-colors duration-100",
                    // Hover/active states
                    "hover:bg-muted/50",
                    activeIndex === idx && "bg-primary/10 text-primary"
                  )}
                  id={getOptionId(idx)}
                  onClick={() => addTag(opt.tag)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  role="option"
                >
                  {/* Tag name with hierarchy highlight */}
                  <span className="flex items-center gap-1.5 font-mono text-sm">
                    {opt.prefix ? (
                      <>
                        <span className="text-muted-foreground/50">
                          {opt.prefix}/
                        </span>
                        <span>{opt.displayName}</span>
                      </>
                    ) : (
                      <span>{opt.tag}</span>
                    )}
                  </span>

                  {/* Document count - brass pill */}
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5",
                      "bg-secondary/15 font-mono text-[10px] text-secondary",
                      "border border-secondary/20"
                    )}
                  >
                    {opt.count}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Screen reader live region */}
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );
}
