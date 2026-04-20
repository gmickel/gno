/**
 * Obsidian-aware markdown pre-processor for publish export.
 *
 * Strips wikilinks, drops navigation sidebar idioms, removes references to
 * private (`_internal/`) paths, and warns on unresolvable image embeds before
 * the markdown enters the publish artifact.
 *
 * @module src/publish/obsidian-sanitize
 */

const WIKILINK_INTERNAL_PREFIX = /_internal\//i;
const NAV_SIDEBAR_LINE = /^(!?\[\[[^\]]+\]\]\s*\|?\s*)+$/;
const IMAGE_EMBED = /!\[\[([^\]]+)\]\]/g;
const INTERNAL_WIKILINK = /\[\[\s*_internal\/[^\]]+\]\]/gi;
const ALIASED_WIKILINK = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
const BARE_WIKILINK = /\[\[([^\]]+)\]\]/g;
const TAIL_SEGMENT = /[^/]+$/;
const BLOCK_ID_SUFFIX = /#\^?[\w-]+$/;

export interface SanitizeWarning {
  kind:
    | "image-embed-dropped"
    | "internal-reference-stripped"
    | "nav-sidebar-dropped"
    | "wikilink-unresolved";
  detail: string;
}

export interface SanitizeResult {
  markdown: string;
  warnings: SanitizeWarning[];
}

const splitFrontmatter = (
  source: string
): { body: string; frontmatter: string } => {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { body: source, frontmatter: "" };
  }
  const endIndex = source.indexOf("\n---\n");
  const endIndexCrlf = source.indexOf("\r\n---\r\n");
  const terminators = [endIndex, endIndexCrlf].filter((index) => index !== -1);
  if (terminators.length === 0) {
    return { body: source, frontmatter: "" };
  }
  const earliest = Math.min(...terminators);
  const matched =
    earliest === endIndex
      ? source.slice(0, earliest + 5)
      : source.slice(0, earliest + 7);
  return {
    body: source.slice(matched.length),
    frontmatter: matched,
  };
};

const deriveLinkDisplay = (target: string): string => {
  const raw = target.trim();
  const withoutBlockId = raw.replace(BLOCK_ID_SUFFIX, "").trim();
  const tail = withoutBlockId.match(TAIL_SEGMENT)?.[0] ?? withoutBlockId;
  return tail.trim() || raw;
};

export function sanitizeObsidianMarkdown(source: string): SanitizeResult {
  const { body, frontmatter } = splitFrontmatter(source);
  const warnings: SanitizeWarning[] = [];
  const lines = body.split("\n");
  const output: string[] = [];
  let seenContent = false;

  for (const rawLine of lines) {
    const rawTrimmed = rawLine.trim();

    if (!seenContent && rawTrimmed && NAV_SIDEBAR_LINE.test(rawTrimmed)) {
      warnings.push({
        kind: "nav-sidebar-dropped",
        detail: rawTrimmed,
      });
      continue;
    }

    let line = rawLine;

    line = line.replace(IMAGE_EMBED, (_match, target: string) => {
      warnings.push({
        kind: "image-embed-dropped",
        detail: target.trim(),
      });
      return "";
    });

    line = line.replace(INTERNAL_WIKILINK, (match) => {
      warnings.push({
        kind: "internal-reference-stripped",
        detail: match,
      });
      return "";
    });

    line = line.replace(
      ALIASED_WIKILINK,
      (_match, target: string, alias: string) => {
        if (WIKILINK_INTERNAL_PREFIX.test(target)) {
          warnings.push({
            kind: "internal-reference-stripped",
            detail: target.trim(),
          });
          return "";
        }
        return alias.trim();
      }
    );

    line = line.replace(BARE_WIKILINK, (_match, target: string) => {
      if (WIKILINK_INTERNAL_PREFIX.test(target)) {
        warnings.push({
          kind: "internal-reference-stripped",
          detail: target.trim(),
        });
        return "";
      }
      const display = deriveLinkDisplay(target);
      warnings.push({
        kind: "wikilink-unresolved",
        detail: target.trim(),
      });
      return display;
    });

    if (line.trim()) {
      seenContent = true;
    }

    output.push(line);
  }

  return {
    markdown: `${frontmatter}${output.join("\n")}`,
    warnings,
  };
}

const FRONTMATTER_PUBLISH_FALSE = /^publish:\s*(false|no|0)\s*$/im;

export function isPublishDisabledByFrontmatter(source: string): boolean {
  const { frontmatter } = splitFrontmatter(source);
  if (!frontmatter) {
    return false;
  }
  return FRONTMATTER_PUBLISH_FALSE.test(frontmatter);
}

export function formatSanitizeWarnings(warnings: SanitizeWarning[]): string[] {
  const grouped = new Map<SanitizeWarning["kind"], Set<string>>();
  for (const warning of warnings) {
    const bucket = grouped.get(warning.kind) ?? new Set<string>();
    bucket.add(warning.detail);
    grouped.set(warning.kind, bucket);
  }

  const labels: Record<SanitizeWarning["kind"], string> = {
    "image-embed-dropped": "Image embeds dropped (attachments not bundled yet)",
    "internal-reference-stripped": "Private `_internal/` references stripped",
    "nav-sidebar-dropped": "Navigation sidebar lines dropped",
    "wikilink-unresolved":
      "Wikilinks converted to plain text (no in-space target)",
  };

  return Array.from(grouped.entries()).flatMap(([kind, details]) => {
    const lines = [`- ${labels[kind]}:`];
    for (const detail of Array.from(details).sort()) {
      lines.push(`    • ${detail}`);
    }
    return lines;
  });
}
