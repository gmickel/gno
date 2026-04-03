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

  // Parse YAML manually (simple key: value pairs)
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let multilineValue: string[] = [];

  for (const line of yamlBlock.split("\n")) {
    // Check for multiline continuation (starts with spaces and not a new key)
    if (currentKey && line.match(/^\s+/) && !line.includes(":")) {
      multilineValue.push(line.trim());
      continue;
    }

    // Save previous multiline value
    if (currentKey && multilineValue.length > 0) {
      const existing = data[currentKey];
      if (typeof existing === "string" && existing.endsWith("|")) {
        data[currentKey] = multilineValue.join("\n");
      } else if (typeof existing === "string") {
        data[currentKey] = `${existing}\n${multilineValue.join("\n")}`;
      } else {
        data[currentKey] = multilineValue.join("\n");
      }
      multilineValue = [];
    }

    // Parse new key: value
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      const [, rawKey = "", rawValue = ""] = match;
      currentKey = rawKey.trim();
      let value: unknown = rawValue.trim();

      // Remove surrounding quotes
      if (
        (value as string).startsWith('"') &&
        (value as string).endsWith('"')
      ) {
        value = (value as string).slice(1, -1);
      }

      // Parse numbers
      if (/^-?\d+\.?\d*$/.test(value as string)) {
        value = Number.parseFloat(value as string);
      }

      data[currentKey] = value;
    }
  }

  // Handle trailing multiline
  if (currentKey && multilineValue.length > 0) {
    const existing = data[currentKey];
    if (typeof existing === "string" && existing.endsWith("|")) {
      data[currentKey] = multilineValue.join("\n");
    } else if (typeof existing === "string") {
      data[currentKey] = `${existing}\n${multilineValue.join("\n")}`;
    } else {
      data[currentKey] = multilineValue.join("\n");
    }
  }

  return { data, body };
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
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((item, i) => (
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
        "group min-w-0 rounded-lg bg-muted/20 p-3 transition-colors hover:bg-muted/30",
        isLarge && "col-span-full"
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground text-xs">
        {icon}
        <span className="uppercase tracking-wider">{formatKey(keyName)}</span>
      </div>
      <div className="text-sm">
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
