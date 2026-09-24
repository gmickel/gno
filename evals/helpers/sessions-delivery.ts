/**
 * Sessions eval delivery: run the same bounded retrieval on each arm and
 * judge the delivered text against the hand-normalized gold turns.
 *
 * A delivered item carries a gold turn only when the exact gold text is fully
 * present in the delivered text, the turn's identity (thread + native logical
 * turn id) is verified from what the arm delivered, and every role signal the
 * arm delivers agrees with the gold role. Partial overlap or a thread-level
 * hit does not count.
 *
 * @module evals/helpers/sessions-delivery
 */

import type { ContextCapsuleV1 } from "../../src/core/context-capsule";
import type { CasesFixture, GoldTurn, Role } from "./sessions-fixtures";
import type { Arm, ArmContext } from "./sessions-harness";

import { buildContextCapsule } from "../../src/app/context-runtime";
import { searchBm25 } from "../../src/pipeline/search";
import { GOLD_REDACTION } from "./sessions-fixtures";
import { goldArmProjectLabel } from "./sessions-harness";

/** Shared, frozen delivery settings (both arms). */
export interface CapsuleSettings {
  depthPolicy: "fast";
  budgetTokens: number;
  budgetBytes: number;
  safetyMarginTokens: number;
  safetyMarginBytes: number;
  limit: number;
  candidateLimit: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gold text matching
// ─────────────────────────────────────────────────────────────────────────────

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (text: string): string =>
  text.replace(REGEX_SPECIAL, "\\$&");

/** Any redaction marker stands in for the gold `[REDACTED]` placeholder. */
const REDACTION_MARKER = String.raw`\[REDACTED(?::[A-Za-z0-9_-]+)?\]`;

/** Regex source matching the complete gold text (redactions as any marker). */
export const goldTextSource = (text: string): string =>
  text.split(GOLD_REDACTION).map(escapeRegex).join(REDACTION_MARKER);

export const speakerLabel = (role: Role): string =>
  role === "human" ? "Human" : "Assistant";

// ─────────────────────────────────────────────────────────────────────────────
// Delivered items
// ─────────────────────────────────────────────────────────────────────────────

const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;
const unescapeMarkdown = (text: string): string =>
  text.replace(MARKDOWN_ESCAPE, "$1");

export interface DeliveredItem {
  arm: Arm;
  surface: string;
  /** Delivered text after removing markdown escapes. */
  text: string;
  /** Record metadata as delivered by the retrieval surface. */
  author: string | null;
  recordThreadId: string | null;
  categories: string[];
  /** Every role signal the arm delivers (null = expected but absent). */
  roles: Array<Role | null>;
  /** Thread identity as delivered. */
  thread: string | null;
  /** Native logical turn id as delivered. */
  turnId: string | null;
}

interface DeliveredRecord {
  author?: string;
  threadId?: string;
  categories?: string[];
}

const toRole = (value: string | null | undefined): Role | null => {
  if (value === "human" || value?.startsWith("Human")) return "human";
  if (value === "assistant" || value?.startsWith("Assistant")) {
    return "assistant";
  }
  return null;
};

/** Segments of the pipeline's one-line provenance block. */
const provenanceSegments = (text: string): string[] =>
  (/^Provenance: (.+)$/m.exec(text)?.[1] ?? "")
    .split(" · ")
    .map((segment) => segment.trim());

const provenanceTurn = (text: string): string | null =>
  provenanceSegments(text)
    .find((segment) => segment.startsWith("turn "))
    ?.slice("turn ".length) ?? null;

const GOLD_HEADING = /^Turn (.+)$/;
const SPEAKER_PREFIX = /^(Human|Assistant): /m;

/**
 * Parse what an arm delivered. The pipeline arm renders role three ways
 * (record author, speaker prefix, provenance speaker), its thread as
 * record metadata and its turn id in the provenance block; the gold arm
 * delivers role and thread as record metadata and the turn id in its title.
 */
export function parseDelivered(
  arm: Arm,
  surface: string,
  rawText: string,
  title: string | null | undefined,
  record: DeliveredRecord | undefined
): DeliveredItem {
  const text = unescapeMarkdown(rawText);
  const author = record?.author ?? null;
  const recordThreadId = record?.threadId ?? null;
  const categories = [...(record?.categories ?? [])].sort();
  if (arm === "pipeline") {
    return {
      arm,
      surface,
      text,
      author,
      recordThreadId,
      categories,
      roles: [
        toRole(author),
        toRole(SPEAKER_PREFIX.exec(text)?.[1]),
        toRole(provenanceSegments(text)[0]),
      ],
      thread: recordThreadId,
      turnId: provenanceTurn(text),
    };
  }
  const heading = GOLD_HEADING.exec(unescapeMarkdown(title ?? "").trim());
  return {
    arm,
    surface,
    text,
    author,
    recordThreadId,
    categories,
    roles: [toRole(author)],
    thread: recordThreadId,
    turnId: heading?.[1] ?? null,
  };
}

/** The single role an item delivers, or null when its signals disagree. */
export const deliveredRole = (item: DeliveredItem): Role | null => {
  const [first] = item.roles;
  return first && item.roles.every((role) => role === first) ? first : null;
};

/** Whether the item presents `text` (complete) as spoken by `role`. */
export function presentsText(
  item: DeliveredItem,
  text: string,
  role: Role
): boolean {
  if (!item.roles.includes(role)) return false;
  const source =
    item.arm === "pipeline"
      ? `${speakerLabel(role)}: ${goldTextSource(text)}`
      : goldTextSource(text);
  return new RegExp(source).test(item.text);
}

/** Whether a delivered item carries the gold turn fully, with verified identity and role. */
export function carriesTurn(item: DeliveredItem, gold: GoldTurn): boolean {
  return (
    item.turnId === gold.turn &&
    item.thread === gold.threadKey &&
    item.recordThreadId === gold.threadKey &&
    deliveredRole(item) === gold.role &&
    presentsText(item, gold.text, gold.role)
  );
}

export const itemKey = (item: DeliveredItem): string =>
  `${item.thread ?? "?"}#${item.turnId ?? "?"}`;

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval surfaces
// ─────────────────────────────────────────────────────────────────────────────

/** BM25 lookup; each hit is delivered as its full indexed record text. */
export async function runLookup(
  ctx: ArmContext,
  query: string,
  depth: number,
  surface: string
): Promise<DeliveredItem[]> {
  const result = await searchBm25(ctx.store, query, { limit: depth });
  if (!result.ok) throw new Error(`${ctx.arm} lookup: ${result.error.message}`);
  const items: DeliveredItem[] = [];
  for (const hit of result.value.results) {
    const mirrorHash = hit.conversion?.mirrorHash;
    const content = mirrorHash
      ? await ctx.store.getContent(mirrorHash)
      : undefined;
    const text = content?.ok && content.value ? content.value : hit.snippet;
    items.push(parseDelivered(ctx.arm, surface, text, hit.title, hit.record));
  }
  return items;
}

/** The arm's own filter label for a question's project. */
export function projectFilter(
  arm: Arm,
  project: string,
  projectIds: CasesFixture["projectIds"]
): string {
  if (arm === "gold") return goldArmProjectLabel(project);
  const id = projectIds[project];
  if (!id) throw new Error(`no expected project id for ${project}`);
  return `project-id/${id}`;
}

export interface CapsuleRun {
  capsule: ContextCapsuleV1 | null;
  abstention: string | null;
  items: DeliveredItem[];
  /** Retrieved candidates the capsule left out, with the stored text (diagnostics only). */
  omitted: Array<{ reason: string; text: string }>;
}

/** Bounded Context Capsule delivery with the frozen shared settings. */
export async function runCapsule(
  ctx: ArmContext,
  question: CasesFixture["questions"][number],
  settings: CapsuleSettings,
  projectIds: CasesFixture["projectIds"]
): Promise<CapsuleRun> {
  const categories = question.project
    ? [projectFilter(ctx.arm, question.project, projectIds)]
    : undefined;
  try {
    const capsule = await buildContextCapsule(
      {
        goal: question.goal,
        queryModes: question.queryModes,
        ...(question.author ? { author: question.author } : {}),
        ...(categories ? { categories } : {}),
        ...settings,
      },
      { store: ctx.store, config: ctx.config, indexName: ctx.indexName }
    );
    const omitted: CapsuleRun["omitted"] = [];
    for (const omission of capsule.omissions.items) {
      const content = await ctx.store.getContent(omission.mirrorHash);
      if (content.ok && content.value) {
        omitted.push({
          reason: omission.reason,
          text: unescapeMarkdown(content.value),
        });
      }
    }
    return {
      capsule,
      abstention: null,
      omitted,
      items: capsule.evidence.map((evidence) =>
        parseDelivered(
          ctx.arm,
          `capsule ${question.id}`,
          evidence.text,
          evidence.title,
          evidence.record
        )
      ),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "error";
    return {
      capsule: null,
      abstention: `${code}: ${error instanceof Error ? error.message : String(error)}`,
      items: [],
      omitted: [],
    };
  }
}
