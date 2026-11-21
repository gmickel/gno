/**
 * Markdown canonicalization for deterministic output.
 * PRD §8.4 - Canonical Markdown conventions
 *
 * CRITICAL: These rules are a compatibility contract.
 * Changing them invalidates all existing mirrorHash values.
 */

/**
 * Control character pattern built dynamically to avoid lint issues with literal control chars.
 * Matches U+0000-U+0008, U+000B-U+000C, U+000E-U+001F, U+007F (excludes \n and \t)
 */
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);

/** Returns true if value contains any non-ASCII code unit; pure ASCII is already NFC. */
function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Canonicalize markdown to ensure deterministic output.
 *
 * Rules (PRD §8.4):
 * 0. Strip BOM (U+FEFF) if present
 * 1. Normalize to \n newlines (no \r)
 * 2. Apply NFC Unicode normalization (cross-platform hash stability)
 * 3. Strip control chars U+0000-U+001F and U+007F except \n (U+000A) and \t (U+0009)
 * 4. Trim trailing whitespace per line
 * 5. Treat whitespace-only lines as blank (trim first, then count)
 * 6. Collapse 2+ consecutive blank lines to exactly 1 (content\n\ncontent)
 * 7. Ensure exactly one final \n
 */
export function canonicalize(markdown: string): string {
  if (!markdown) {
    return "\n";
  }

  // 0. Strip BOM if present (U+FEFF) - ensures deterministic hashing
  let result = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;

  // 1. Normalize line endings: \r\n → \n, lone \r → \n
  if (result.includes("\r")) {
    result = result.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  // 2. Apply NFC Unicode normalization (skip only for strictly pure ASCII)
  if (hasNonAscii(result)) {
    result = result.normalize("NFC");
  }

  // 3. Strip control characters except \n (U+000A) and \t (U+0009)
  // Range: U+0000-U+0008, U+000B-U+000C, U+000E-U+001F, U+007F
  result = result.replace(CONTROL_CHAR_PATTERN, "");

  // 4. Trim trailing whitespace per line and
  // 5. Treat whitespace-only lines as blank
  const lines = result.split("\n").map((line) => line.trimEnd());

  // 6. Collapse multiple blank lines to exactly 1
  // (i.e., content\n\ncontent between paragraphs)
  const collapsed: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line === "") {
      blankCount += 1;
      // Only keep one blank line between content
      if (blankCount === 1) {
        collapsed.push(line);
      }
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }

  // 7. Ensure exactly one final \n
  // Remove trailing blank lines first
  while (collapsed.length > 0 && collapsed.at(-1) === "") {
    collapsed.pop();
  }

  // Join and add single final newline
  return `${collapsed.join("\n")}\n`;
}

/**
 * Compute SHA-256 hash of canonical markdown.
 * Returns lowercase hex string (64 chars).
 */
export function mirrorHash(canonical: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}
