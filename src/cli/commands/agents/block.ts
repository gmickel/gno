/**
 * GNO agents protocol block: content, markers, hashing, extraction.
 *
 * One compact, versioned instruction block bounded by stable BEGIN/END
 * markers. Install/update/uninstall touch ONLY the owned block; content
 * outside the markers stays byte-identical.
 *
 * @module src/cli/commands/agents/block
 */

import type { SkillTarget } from "../skill/paths.js";

import { CliError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Version of the protocol block content. Bump on any content change. */
export const BLOCK_VERSION = 1;

/** Stable across block versions — never change these once shipped. */
export const BEGIN_MARKER = "<!-- gno:agents:begin -->";
export const END_MARKER = "<!-- gno:agents:end -->";

const STAMP_RE = /^<!-- gno-agents block v(\d+) sha256:([0-9a-f]{16})( \+nl)? /;
const HASH_PREFIX_LENGTH = 16;

/**
 * Stamp-line provenance token: install appended a final newline to a file
 * that had none, so uninstall must consume that one newline to restore the
 * original bytes. Recorded inside the markers because separator provenance
 * cannot be inferred from file shape at uninstall time.
 */
const ADDED_NEWLINE_TOKEN = " +nl";

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The consumers of one instruction file that still lack the skill — drives a
 * remediation scoped to exactly those harnesses, so following it never
 * fabricates skill/config dirs for harnesses the operator never installed.
 */
export interface SkillRemediation {
  /** Standard harness skill targets lacking the skill (deduped). */
  targets: SkillTarget[];
  /** `--extra-dir` instances lacking the skill (their config dir). */
  extraDirs: string[];
}

export interface BlockRenderOptions {
  /** Whether the GNO agent skill is installed for every consumer. */
  skillInstalled: boolean;
  /**
   * Install appended a final newline to a file that had none. Stamped into
   * the block (` +nl`) so uninstall knows the newline above the block is
   * install-owned, not user content. Authenticated by the stamp hash: the
   * hash covers body + token, so a stripped or added token fails verify.
   */
  addedLeadingNewline?: boolean;
  /**
   * Consumers lacking the skill, for the remediation command. Absent (no
   * consumer information) falls back to the generic all-targets form.
   */
  remediation?: SkillRemediation;
}

/**
 * Single-quote a path for a shell command line. Single quotes are literal in
 * POSIX shells AND PowerShell — no parameter/command substitution, no
 * backtick or `$` expansion — unlike double quotes. The one divergence is an
 * embedded `'`: POSIX closes/reopens (`'\''`), PowerShell doubles (`''`). The
 * block is rendered on the machine that will run the command, so the active
 * platform picks the idiom.
 */
export function quotePathForShell(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  const escaped =
    platform === "win32"
      ? path.replace(/'/g, "''")
      : path.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

/**
 * Render the remediation the conservative pointer asks the agent to run.
 * One `gno skill install` per consumer harness that lacks the skill; an
 * `--extra-dir` instance is addressed through its own skills dir via the
 * portable `--skills-dir` option (single-quoted — expansion-safe).
 */
export function renderRemediation(remediation?: SkillRemediation): string {
  const targets = [...new Set(remediation?.targets ?? [])];
  const extraDirs = remediation?.extraDirs ?? [];
  if (targets.length === 0 && extraDirs.length === 0) {
    return "gno skill install --scope user --force --target all";
  }
  const commands = [
    ...targets.map(
      (t) => `gno skill install --scope user --force --target ${t}`
    ),
    ...extraDirs.map(
      (dir) =>
        `gno skill install --scope user --force --target claude --skills-dir ${quotePathForShell(`${dir}/skills`)}`
    ),
  ];
  return commands.join("; ");
}

/**
 * Render the protocol block body (between stamp line and end marker).
 * Compact by design: the retrieval ladder + the writing contract. Detailed
 * workflows live in the GNO skill, referenced by the state-aware pointer.
 */
export function renderBlockBody(opts: BlockRenderOptions): string {
  const skillPointer = opts.skillInstalled
    ? "load the installed `gno` skill (`/gno`)"
    : `run \`${renderRemediation(opts.remediation)}\` and load the \`gno\` skill`;
  return `## GNO knowledge retrieval

Local knowledge search over indexed collections. Source files are the truth; the GNO index is disposable, machine-local.

Ladder — scope to a collection first (\`--collection <name>\`):

1. Exact term/identifier/quote/error: \`gno search "<text>"\`
2. Entity or known document: \`gno query "<question>" --fast -n 10\`
3. Multi-document evidence for a goal: \`gno context build "<goal>" --budget 12000\`
4. Change/dependency questions: \`gno changes\` / \`gno diff <doc>\` / \`gno impact <doc>\`
5. Generated factual answer: \`gno ask "<question>" --verify\` (abstention is valid)
6. Expected document missing: reformulate + re-check collection scope (\`gno query diagnose "<query>" --target <doc>\`) before any grep fallback.

Writing: retrieve first — a question alone is read-only. Edit an existing canonical note in its source file; \`gno capture\` creates genuinely new notes (collection, title/path, source kind, provenance) — never an update API. After writes: reindex the collection, verify retrieval.

Cite with gno:// URIs. Advanced retrieval (structured queries, filters, backlinks, similar, capture recipes): ${skillPointer}.`;
}

/**
 * SHA-256 hex digest, truncated for the stamp line. Covers the body AND the
 * newline-provenance token, so the token is authenticated material: deleting
 * or adding ` +nl` by hand invalidates the stamp instead of silently changing
 * what uninstall will consume.
 */
export function hashBlockBody(
  body: string,
  addedLeadingNewline = false
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  if (addedLeadingNewline) {
    hasher.update(`\n${ADDED_NEWLINE_TOKEN}`);
  }
  return hasher.digest("hex").slice(0, HASH_PREFIX_LENGTH);
}

/** Render the stamp line carrying version + authenticated hash (+ `+nl`). */
export function renderStampLine(
  body: string,
  addedLeadingNewline = false
): string {
  const token = addedLeadingNewline ? ADDED_NEWLINE_TOKEN : "";
  return `<!-- gno-agents block v${BLOCK_VERSION} sha256:${hashBlockBody(body, addedLeadingNewline)}${token} — managed by \`gno agents\`; manual edits inside the markers are overwritten -->`;
}

/** True when the extracted stamp authenticates the body + provenance token. */
export function stampAuthenticates(block: {
  body: string;
  stamp: { hash: string; addedLeadingNewline: boolean } | null;
}): boolean {
  return (
    block.stamp !== null &&
    block.stamp.hash ===
      hashBlockBody(block.body, block.stamp.addedLeadingNewline)
  );
}

/** Render the complete block: BEGIN marker, stamp, body, END marker. */
export function renderBlock(opts: BlockRenderOptions): string {
  const body = renderBlockBody(opts);
  return `${BEGIN_MARKER}\n${renderStampLine(body, opts.addedLeadingNewline ?? false)}\n${body}\n${END_MARKER}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction & Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedBlock {
  /** Offset of the BEGIN marker in the file content. */
  start: number;
  /** Offset just past the END marker. */
  end: number;
  /** Everything between the markers (stamp line + body), without markers. */
  inner: string;
  /** Body without the stamp line (equal to inner when no stamp present). */
  body: string;
  /** Parsed stamp, when present and well-formed. */
  stamp: {
    version: number;
    hash: string;
    /** Install recorded that it appended the file's missing final newline. */
    addedLeadingNewline: boolean;
  } | null;
}

export type BlockExtraction =
  | { found: false }
  | { found: true; block: ExtractedBlock };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Extract the managed block from file content.
 * Fail-closed: malformed or duplicate markers throw with guidance — the
 * installer never guesses or "repairs".
 */
export function extractBlock(
  content: string,
  filePath: string
): BlockExtraction {
  const begins = countOccurrences(content, BEGIN_MARKER);
  const ends = countOccurrences(content, END_MARKER);

  if (begins === 0 && ends === 0) {
    return { found: false };
  }

  if (begins !== 1 || ends !== 1) {
    throw new CliError(
      "VALIDATION",
      `Malformed GNO agents markers in ${filePath}: found ${begins} BEGIN and ${ends} END marker(s), expected exactly one of each. ` +
        "Fix or remove the markers manually (or restore the file from its .gno-agents.bak backup), then re-run."
    );
  }

  const start = content.indexOf(BEGIN_MARKER);
  const endMarkerStart = content.indexOf(END_MARKER);
  if (endMarkerStart < start) {
    throw new CliError(
      "VALIDATION",
      `Malformed GNO agents markers in ${filePath}: END marker appears before BEGIN marker. ` +
        "Fix or remove the markers manually (or restore the file from its .gno-agents.bak backup), then re-run."
    );
  }

  const end = endMarkerStart + END_MARKER.length;
  const rawInner = content.slice(start + BEGIN_MARKER.length, endMarkerStart);
  // Trim exactly the structural newlines install added around the inner text.
  const inner = rawInner.replace(/^\n/, "").replace(/\n$/, "");

  const newlineIdx = inner.indexOf("\n");
  const firstLine = newlineIdx === -1 ? inner : inner.slice(0, newlineIdx);
  const stampMatch = STAMP_RE.exec(firstLine);
  const stamp = stampMatch
    ? {
        version: Number(stampMatch[1]),
        hash: stampMatch[2] ?? "",
        addedLeadingNewline: stampMatch[3] !== undefined,
      }
    : null;
  const body = stamp && newlineIdx !== -1 ? inner.slice(newlineIdx + 1) : inner;

  return { found: true, block: { start, end, inner, body, stamp } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Link Resolution (verify)
// ─────────────────────────────────────────────────────────────────────────────

const FILE_REF_RE = /(?:^|[\s("'`])((?:~|\/)[\w~./-]+)/g;

/**
 * Slash-command pointer, not a path: a single extensionless segment after the
 * root slash (e.g. `/gno`). Real absolute file references always carry a
 * nested segment or an extension.
 */
const SLASH_COMMAND_RE = /^\/[\w-]+$/;

/** Text ending in the `--skills-dir '` prefix of a quoted remediation operand. */
const SKILLS_DIR_OPERAND_RE = /--skills-dir\s+['"]$/;

/**
 * Extract filesystem references (absolute or ~-prefixed paths) from a block
 * body. gno:// URIs, bare commands, and slash-command pointers such as
 * `/gno` are not filesystem references.
 * Vacuous (empty result) when the block carries none.
 */
export function extractFileReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(FILE_REF_RE)) {
    const ref = match[1];
    if (!ref || ref.length <= 1 || SLASH_COMMAND_RE.test(ref)) {
      continue;
    }
    // The remediation's `--skills-dir "<path>"` operand names where the skill
    // SHOULD be installed — absent by construction while the conservative
    // pointer renders — so it is a command argument, not a link to validate.
    const refStart = (match.index ?? 0) + match[0].length - ref.length;
    if (SKILLS_DIR_OPERAND_RE.test(body.slice(0, refStart))) {
      continue;
    }
    refs.add(ref);
  }
  return Array.from(refs);
}
