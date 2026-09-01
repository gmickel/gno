/**
 * GNO agents protocol block: content, markers, hashing, extraction.
 *
 * One compact, versioned instruction block bounded by stable BEGIN/END
 * markers. Install/update/uninstall touch ONLY the owned block; content
 * outside the markers stays byte-identical.
 *
 * @module src/cli/commands/agents/block
 */

import { CliError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Version of the protocol block content. Bump on any content change. */
export const BLOCK_VERSION = 1;

/** Stable across block versions — never change these once shipped. */
export const BEGIN_MARKER = "<!-- gno:agents:begin -->";
export const END_MARKER = "<!-- gno:agents:end -->";

const STAMP_RE = /^<!-- gno-agents block v(\d+) sha256:([0-9a-f]{16}) /;
const HASH_PREFIX_LENGTH = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockRenderOptions {
  /** Whether the GNO agent skill is installed for this harness. */
  skillInstalled: boolean;
}

/**
 * Render the protocol block body (between stamp line and end marker).
 * Compact by design: the retrieval ladder + the writing contract. Detailed
 * workflows live in the GNO skill, referenced by the state-aware pointer.
 */
export function renderBlockBody(opts: BlockRenderOptions): string {
  const skillPointer = opts.skillInstalled
    ? "load the installed `gno` skill (`/gno`)"
    : "run `gno skill install` and load the `gno` skill";
  return `## GNO knowledge retrieval

Local knowledge search over indexed collections. Source files are the truth; the GNO index is disposable, machine-local.

Ladder — scope to a collection first (\`--collection <name>\`):

1. Exact term/identifier/quote/error: \`gno search "<text>"\`
2. Entity or known document: \`gno query "<question>" --fast -n 10\`
3. Multi-document evidence for a goal: \`gno context build "<goal>" --budget 12000\`
4. Change/dependency questions: \`gno changes\` / \`gno diff\` / \`gno impact\`
5. Generated factual answer: \`gno ask "<question>" --verify\` (abstention is valid)
6. Expected document missing: reformulate + re-check collection scope (\`gno query diagnose\`) before any grep fallback.

Writing: retrieve first — a question alone is read-only. Edit an existing canonical note in its source file; \`gno capture\` creates genuinely new notes (collection, title/path, source kind, provenance) — never an update API. After writes: reindex the collection, verify retrieval.

Cite with gno:// URIs. Advanced retrieval (structured queries, filters, backlinks, similar, capture recipes): ${skillPointer}.`;
}

/** SHA-256 hex digest, truncated for the stamp line. */
export function hashBlockBody(body: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(body);
  return hasher.digest("hex").slice(0, HASH_PREFIX_LENGTH);
}

/** Render the stamp line carrying version + body hash. */
export function renderStampLine(body: string): string {
  return `<!-- gno-agents block v${BLOCK_VERSION} sha256:${hashBlockBody(body)} — managed by \`gno agents\`; manual edits inside the markers are overwritten -->`;
}

/** Render the complete block: BEGIN marker, stamp, body, END marker. */
export function renderBlock(opts: BlockRenderOptions): string {
  const body = renderBlockBody(opts);
  return `${BEGIN_MARKER}\n${renderStampLine(body)}\n${body}\n${END_MARKER}`;
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
  stamp: { version: number; hash: string } | null;
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
    ? { version: Number(stampMatch[1]), hash: stampMatch[2] ?? "" }
    : null;
  const body = stamp && newlineIdx !== -1 ? inner.slice(newlineIdx + 1) : inner;

  return { found: true, block: { start, end, inner, body, stamp } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Link Resolution (verify)
// ─────────────────────────────────────────────────────────────────────────────

const FILE_REF_RE = /(?:^|[\s("'`])((?:~|\/)[\w~./-]+)/g;

/**
 * Extract filesystem references (absolute or ~-prefixed paths) from a block
 * body. gno:// URIs and bare commands are not filesystem references.
 * Vacuous (empty result) when the block carries none.
 */
export function extractFileReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(FILE_REF_RE)) {
    const ref = match[1];
    if (ref && ref.length > 1) {
      refs.add(ref);
    }
  }
  return Array.from(refs);
}
