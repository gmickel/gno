/**
 * FrontmatterDisplay - Beautiful metadata display for YAML frontmatter.
 *
 * Parses frontmatter from markdown content and displays key-value pairs
 * in a refined grid with special formatting for URLs, dates, durations, etc.
 * Matches the "Scholarly Dusk" design system.
 */

import {
  CalendarIcon,
  ClockIcon,
  ExternalLinkIcon,
  HashIcon,
  LinkIcon,
  TagIcon,
  UserIcon,
} from "lucide-react";
import { memo, useMemo, type FC, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

const INLINE_ARRAY_REGEX = /^\[([^\]]*)\]$/;

function normalizeScalar(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+\.?\d*$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseYamlFrontmatterBlock(yamlBlock: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = yamlBlock.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trimEnd();
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }

    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, rawKey = "", rawValue = ""] = match;
    const key = rawKey.trim();
    const value = rawValue.trim();

    const inlineArrayMatch = INLINE_ARRAY_REGEX.exec(value);
    if (inlineArrayMatch?.[1]) {
      data[key] = inlineArrayMatch[1]
        .split(",")
        .map((item) => normalizeScalar(item))
        .filter((item) => item !== "");
      continue;
    }

    if (value.length === 0) {
      const arrayItems: unknown[] = [];
      let multilineValue: string[] = [];
      let multilineMode = false;

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine === undefined) {
          break;
        }

        const trimmedNext = nextLine.trimEnd();
        if (!trimmedNext) {
          if (multilineMode) {
            multilineValue.push("");
          }
          continue;
        }

        if (!/^\s/.test(nextLine)) {
          break;
        }

        const arrayMatch = nextLine.match(/^\s*-\s*(.*)$/);
        if (arrayMatch) {
          arrayItems.push(normalizeScalar(arrayMatch[1] ?? ""));
          i = j;
          continue;
        }

        multilineMode = true;
        multilineValue.push(nextLine.trim());
        i = j;
      }

      if (arrayItems.length > 0) {
        data[key] = arrayItems;
      } else if (multilineValue.length > 0) {
        data[key] = multilineValue.join("\n");
      } else {
        data[key] = "";
      }
      continue;
    }

    data[key] = normalizeScalar(value);
  }

  return data;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns empty data if no frontmatter found.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trimStart();

  // Check for frontmatter delimiter
  if (!trimmed.startsWith("---")) {
    return { data: {}, body: content };
  }

  // Find closing delimiter
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { data: {}, body: content };
  }

  const yamlBlock = trimmed.slice(4, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trimStart();
  if (typeof Bun !== "undefined" && Bun.YAML) {
    try {
      const parsed = Bun.YAML.parse(yamlBlock);
      return {
        data:
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {},
        body,
      };
    } catch {
      // Fall through to the browser-safe parser below.
    }
  }

  return {
    data: parseYamlFrontmatterBlock(yamlBlock),
    body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Value Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** Check if string looks like a URL */
function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** Check if string looks like a date */
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** Check if key suggests a duration field */
function isDurationKey(key: string): boolean {
  return /duration|time|length/i.test(key);
}

/** Check if key suggests a person/author field */
function isPersonKey(key: string): boolean {
  return /author|guest|host|creator|by/i.test(key);
}

/** Check if key suggests a count/number field */
function isCountKey(key: string): boolean {
  return /count|views|likes|subscribers|followers/i.test(key);
}

/** Check if key suggests tags */
function isTagsKey(key: string): boolean {
  return /tags?|categories|topics/i.test(key);
}

/** Format a duration in seconds to human readable */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/** Format large numbers with K/M suffix */
function formatCount(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toLocaleString();
}

/** Format a date string nicely */
function formatDate(dateStr: string): string {
  const time = Date.parse(dateStr);
  if (Number.isNaN(time)) return dateStr;
  try {
    return new Date(time).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

/** Get icon for a key */
function getKeyIcon(key: string): ReactNode {
  const lowerKey = key.toLowerCase();

  if (isPersonKey(key)) {
    return <UserIcon className="size-3.5" />;
  }
  if (isDurationKey(key)) {
    return <ClockIcon className="size-3.5" />;
  }
  if (isCountKey(key)) {
    return <HashIcon className="size-3.5" />;
  }
  if (isTagsKey(key)) {
    return <TagIcon className="size-3.5" />;
  }
  if (lowerKey.includes("url") || lowerKey.includes("link")) {
    return <LinkIcon className="size-3.5" />;
  }
  if (lowerKey.includes("date") || lowerKey.includes("published")) {
    return <CalendarIcon className="size-3.5" />;
  }

  return null;
}

/** Format a key name for display */
function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

interface ValueDisplayProps {
  keyName: string;
  value: unknown;
}

const ValueDisplay: FC<ValueDisplayProps> = ({ keyName, value }) => {
  // Handle arrays (tags, etc.)
  if (Array.isArray(value)) {
    const normalizedValues = value.filter(
      (item): item is string | number =>
        typeof item === "string" || typeof item === "number"
    );

    if (normalizedValues.length === 0) {
      return null;
    }

    if (isTagsKey(keyName)) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {normalizedValues.map((item, i) => (
            <Badge
              className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary"
              key={`${item}-${i}`}
              variant="outline"
            >
              {String(item)}
            </Badge>
          ))}
        </div>
      );
    }

    if (
      normalizedValues.every((item) => typeof item === "string" && isUrl(item))
    ) {
      return (
        <div className="space-y-2">
          {normalizedValues.map((item, i) => (
            <a
              className="flex max-w-full items-start gap-1 text-primary hover:underline"
              href={String(item)}
              key={`${item}-${i}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="break-all">{String(item)}</span>
              <ExternalLinkIcon className="mt-0.5 size-3 shrink-0 opacity-60" />
            </a>
          ))}
        </div>
      );
    }

    return (
      <div className="flex flex-wrap gap-1.5">
        {normalizedValues.map((item, i) => (
          <Badge
            className="font-mono text-xs"
            key={`${item}-${i}`}
            variant="secondary"
          >
            {String(item)}
          </Badge>
        ))}
      </div>
    );
  }

  // Handle URLs
  if (typeof value === "string" && isUrl(value)) {
    return (
      <a
        className="flex max-w-full items-start gap-1 text-primary hover:underline"
        href={value}
        rel="noopener noreferrer"
        target="_blank"
      >
        <span className="line-clamp-2 break-all">{value}</span>
        <ExternalLinkIcon className="size-3 shrink-0 opacity-60" />
      </a>
    );
  }

  // Handle dates
  if (typeof value === "string" && isDate(value)) {
    return <span className="text-foreground">{formatDate(value)}</span>;
  }

  // Handle duration seconds
  if (
    typeof value === "number" &&
    isDurationKey(keyName) &&
    keyName.toLowerCase().includes("second")
  ) {
    return (
      <span className="font-mono text-foreground">{formatDuration(value)}</span>
    );
  }

  // Handle counts
  if (typeof value === "number" && isCountKey(keyName)) {
    return (
      <span className="font-mono text-foreground">{formatCount(value)}</span>
    );
  }

  // Handle multiline text (descriptions)
  if (typeof value === "string" && value.includes("\n")) {
    return <span className="line-clamp-3 text-foreground/80">{value}</span>;
  }

  // Handle long text
  if (typeof value === "string" && value.length > 100) {
    return <span className="line-clamp-2 text-foreground/80">{value}</span>;
  }

  // Default display
  return <span className="text-foreground">{String(value)}</span>;
};

interface FrontmatterItemProps {
  keyName: string;
  value: unknown;
  isLarge?: boolean;
}

const FrontmatterItem: FC<FrontmatterItemProps> = ({
  keyName,
  value,
  isLarge,
}) => {
  const icon = getKeyIcon(keyName);

  return (
    <div
      className={cn(
        "group min-w-0 rounded-lg bg-muted/20 p-2.5 transition-colors hover:bg-muted/30",
        isLarge && "col-span-full"
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground text-[11px]">
        {icon}
        <span className="uppercase tracking-wider">{formatKey(keyName)}</span>
      </div>
      <div className="text-sm leading-relaxed">
        <ValueDisplay keyName={keyName} value={value} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export interface FrontmatterDisplayProps {
  /** Raw markdown content with frontmatter */
  content: string;
  /** Additional CSS classes */
  className?: string;
  /** Callback with body content (frontmatter stripped) */
  onBodyExtracted?: (body: string) => void;
}

/**
 * Displays YAML frontmatter in a beautiful metadata grid.
 * Automatically detects and formats URLs, dates, durations, counts, etc.
 */
export const FrontmatterDisplay = memo(
  ({ content, className }: FrontmatterDisplayProps) => {
    const { data } = useMemo(() => parseFrontmatter(content), [content]);

    const entries = Object.entries(data).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    );

    if (entries.length === 0) {
      return null;
    }

    // Determine which fields should span full width
    const isLargeField = (key: string, value: unknown): boolean => {
      if (typeof value === "string") {
        return value.length > 80 || value.includes("\n");
      }
      if (key.toLowerCase().includes("description")) {
        return true;
      }
      return false;
    };

    // Sort: small fields first (for grid layout), large fields last
    const sortedEntries = [...entries].sort(([keyA, valA], [keyB, valB]) => {
      const aLarge = isLargeField(keyA, valA);
      const bLarge = isLargeField(keyB, valB);
      if (aLarge && !bLarge) return 1;
      if (!aLarge && bLarge) return -1;
      return 0;
    });

    return (
      <div
        className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-3", className)}
      >
        {sortedEntries.map(([key, value]) => (
          <FrontmatterItem
            isLarge={isLargeField(key, value)}
            key={key}
            keyName={key}
            value={value}
          />
        ))}
      </div>
    );
  }
);

FrontmatterDisplay.displayName = "FrontmatterDisplay";

// Re-export parser for use elsewhere
export { type ParsedFrontmatter };
