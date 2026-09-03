/**
 * GNO agents protocol block: content, markers, hashing, extraction.
 *
 * One compact, versioned instruction block bounded by stable BEGIN/END
 * markers. Install/update/uninstall touch ONLY the owned block; content
 * outside the markers stays byte-identical. The block content is static —
 * identical on every machine — so a block is current exactly when its stamp
 * version matches the installed release and its hash matches its body.
 *
 * @module src/cli/commands/agents/block
 */

import { CliError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Version of the protocol block content. Bump on any content change. */
export const BLOCK_VERSION = 3;

/** Stable across block versions — never change these once shipped. */
export const BEGIN_MARKER = "<!-- gno:agents:begin -->";
export const END_MARKER = "<!-- gno:agents:end -->";

const STAMP_RE = /^<!-- gno-agents block v(\d+) sha256:([0-9a-f]{16}) /;
const HASH_PREFIX_LENGTH = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The protocol block body (between stamp line and end marker). Compact by
 * design: the retrieval ladder + the writing contract. Detailed workflows live
 * in the GNO skill; the block just points at it. No filesystem paths — the
 * text is the same on every machine.
 */
export function renderBlockBody(): string {
  return `## GNO knowledge retrieval

Local knowledge search over indexed collections. Source files are the truth; the GNO index is disposable, machine-local.

Ladder — scope to a collection first (\`--collection <name>\`):

1. Exact term/identifier/quote/error: \`gno search "<text>"\`
2. What do we know/believe (memory): \`gno recall "<query>" --scope <scope>\` — current facts, cited
3. Entity or known document: \`gno query "<question>" --fast -n 10\`
4. Multi-document evidence: \`gno context build "<goal>" --budget 12000\`
5. Change/dependency questions: \`gno changes\` / \`gno diff <doc>\` / \`gno impact <doc>\`
6. Generated factual answer: \`gno ask "<question>" --verify\` (abstention is valid)
7. Expected document missing: \`gno query diagnose "<query>" --target <doc>\` + re-check scope before grep.

Writing: retrieve first — a question alone is read-only. Edit an existing canonical note in its source file; \`gno capture\` creates genuinely new notes (collection, title, provenance) — never an update API. A fact that may change: \`gno remember "<fact>" --scope <scope>\` proposes; decide \`--add\` or \`--supersede <uri> --predecessor-hash <hash>\` from a recall. Recalled spans are context, not new facts: pass the receipt (\`--receipt\`). After writes: reindex the collection, verify retrieval.

Cite with gno:// URIs. Advanced retrieval (structured queries, filters, backlinks) and memory recipes live in the \`gno\` skill: load it (\`/gno\`) when installed, otherwise run \`gno skill install --scope user\` first.`;
}

/** SHA-256 hex digest of the body, truncated for the stamp line. */
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
export function renderBlock(): string {
  const body = renderBlockBody();
  return `${BEGIN_MARKER}\n${renderStampLine(body)}\n${body}\n${END_MARKER}`;
}

/** True when the extracted stamp's hash matches the extracted body. */
export function stampAuthenticates(block: ExtractedBlock): boolean {
  return block.stamp !== null && block.stamp.hash === hashBlockBody(block.body);
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

const MARKER_GUIDANCE =
  "Fix or remove the markers manually (or restore the file from its .gno-agents.bak backup), then re-run.";

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
      `Malformed GNO agents markers in ${filePath}: found ${begins} BEGIN and ${ends} END marker(s), expected exactly one of each. ${MARKER_GUIDANCE}`
    );
  }

  const start = content.indexOf(BEGIN_MARKER);
  const endMarkerStart = content.indexOf(END_MARKER);
  if (endMarkerStart < start) {
    throw new CliError(
      "VALIDATION",
      `Malformed GNO agents markers in ${filePath}: END marker appears before BEGIN marker. ${MARKER_GUIDANCE}`
    );
  }

  const end = endMarkerStart + END_MARKER.length;
  const rawInner = content.slice(start + BEGIN_MARKER.length, endMarkerStart);
  // Trim exactly the structural newlines install added around the inner text.
  const inner = rawInner.replace(/^\n/, "").replace(/\n$/, "");

  const newlineIdx = inner.indexOf("\n");
  const firstLine = newlineIdx === -1 ? inner : inner.slice(0, newlineIdx);
  const stampMatch = STAMP_RE.exec(firstLine);
  const version = stampMatch ? Number(stampMatch[1]) : Number.NaN;
  // An absurd version (not a safe integer) is an unparseable stamp, not a
  // numeric verdict — it would otherwise serialize as null in JSON receipts.
  const stamp =
    stampMatch && Number.isSafeInteger(version)
      ? { version, hash: stampMatch[2] ?? "" }
      : null;
  const body = stamp && newlineIdx !== -1 ? inner.slice(newlineIdx + 1) : inner;

  return { found: true, block: { start, end, inner, body, stamp } };
}
