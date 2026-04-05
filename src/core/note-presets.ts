/**
 * Shared note preset definitions and scaffold helpers.
 *
 * Browser-safe: no Bun APIs.
 *
 * @module src/core/note-presets
 */

import { normalizeTag } from "./tags";

export type NotePresetId =
  | "blank"
  | "project-note"
  | "research-note"
  | "decision-note"
  | "prompt-pattern"
  | "source-summary";

export interface NotePresetDefinition {
  id: NotePresetId;
  label: string;
  description: string;
  defaultTags?: string[];
  frontmatter?: Record<string, string | string[]>;
  body: (title: string) => string;
}

export interface ResolvedNotePreset {
  preset: NotePresetDefinition;
  title: string;
  tags: string[];
  frontmatter: Record<string, string | string[]>;
  body: string;
  content: string;
}

function serializeFrontmatterValue(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? []
      : value.map((entry) => `  - ${JSON.stringify(entry)}`);
  }
  return [JSON.stringify(value)];
}

export function serializeFrontmatter(
  data: Record<string, string | string[]>
): string {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return "";
  }

  const lines = ["---"];
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
    } else {
      lines.push(`${key}: ${serializeFrontmatterValue(value)[0]}`);
      continue;
    }
    for (const line of serializeFrontmatterValue(value)) {
      lines.push(line);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

export const NOTE_PRESETS: NotePresetDefinition[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Empty note with only a title heading.",
    body: (title) => `# ${title}\n`,
  },
  {
    id: "project-note",
    label: "Project Note",
    description: "Goal, scope, open questions, and next steps.",
    defaultTags: ["project"],
    frontmatter: {
      category: "project",
      status: "active",
    },
    body: (title) =>
      `# ${title}\n\n## Goal\n\n## Scope\n\n## Open Questions\n\n## Next Steps\n`,
  },
  {
    id: "research-note",
    label: "Research Note",
    description: "Summary, key ideas, evidence, and follow-up questions.",
    defaultTags: ["research"],
    frontmatter: {
      category: "research",
    },
    body: (title) =>
      `# ${title}\n\n## Summary\n\n## Key Ideas\n\n## Evidence\n\n## Follow-up Questions\n`,
  },
  {
    id: "decision-note",
    label: "Decision Note",
    description: "Context, decision, rationale, and consequences.",
    defaultTags: ["decision"],
    frontmatter: {
      category: "decision",
      status: "proposed",
    },
    body: (title) =>
      `# ${title}\n\n## Context\n\n## Decision\n\n## Rationale\n\n## Consequences\n`,
  },
  {
    id: "prompt-pattern",
    label: "Prompt / Pattern",
    description: "Capture reusable prompts, constraints, and examples.",
    defaultTags: ["prompt", "pattern"],
    frontmatter: {
      category: "pattern",
    },
    body: (title) =>
      `# ${title}\n\n## Use Case\n\n## Prompt\n\n## Constraints\n\n## Example\n`,
  },
  {
    id: "source-summary",
    label: "Source Summary",
    description: "Summarize an article, paper, or external source cleanly.",
    defaultTags: ["source", "summary"],
    frontmatter: {
      category: "source-summary",
      sources: [],
    },
    body: (title) =>
      `# ${title}\n\n## Summary\n\n## Important Claims\n\n## Evidence / Quotes\n\n## Takeaways\n`,
  },
];

export function getNotePreset(
  presetId?: string | null
): NotePresetDefinition | null {
  if (!presetId) {
    return null;
  }
  return NOTE_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export function resolveNotePreset(input: {
  presetId?: string | null;
  title: string;
  tags?: string[];
  frontmatter?: Record<string, string | string[]>;
  body?: string;
}): ResolvedNotePreset | null {
  const preset = getNotePreset(input.presetId);
  if (!preset) {
    return null;
  }

  const title = input.title.trim() || "Untitled";
  const presetTags = (preset.defaultTags ?? []).map(normalizeTag);
  const tags = [
    ...new Set([...(input.tags ?? []).map(normalizeTag), ...presetTags]),
  ];
  const frontmatter = {
    ...preset.frontmatter,
    ...input.frontmatter,
    ...(tags.length > 0 ? { tags } : {}),
  };
  const body = input.body?.trim().length ? input.body : preset.body(title);
  const frontmatterBlock = serializeFrontmatter(frontmatter);

  return {
    preset,
    title,
    tags,
    frontmatter,
    body,
    content: `${frontmatterBlock}${body}`.trimEnd() + "\n",
  };
}
