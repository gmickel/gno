/**
 * Typed metadata discovery: which keys the indexed documents carry, with
 * their observed types, document counts and most common values, so a caller
 * can write a `filter` predicate for metadata it has not seen.
 *
 * @module src/core/metadata-discovery
 */

export type MetadataValue = string | number | boolean;

export interface MetadataKeySummary {
  key: string;
  /** Observed value types, e.g. `string`, `number`, `string[]`. */
  types: string[];
  /** Documents that carry the key. */
  documents: number;
  /** Most common values (array members count individually), count desc. */
  values: { value: MetadataValue; documents: number }[];
  /** True when more distinct values exist than `values` lists. */
  valuesTruncated: boolean;
}

export interface MetadataSummary {
  collection: string | null;
  /** Active documents in scope, and how many carry typed metadata. */
  documents: number;
  documentsWithMetadata: number;
  keys: MetadataKeySummary[];
}

export const DEFAULT_METADATA_VALUE_LIMIT = 10;
export const MAX_METADATA_VALUE_LIMIT = 100;

const typeOf = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const member = value.length > 0 ? typeOf(value[0]) : "string";
    return member ? `${member}[]` : null;
  }
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? typeof value
    : null;
};

/**
 * Summarize stored typed metadata JSON. Keys sort by document count then
 * name; values by document count then their JSON text, so output is stable.
 */
export function summarizeTypedMetadata(
  input: {
    collection: string | null;
    documents: number;
    metadata: string[];
  },
  valueLimit = DEFAULT_METADATA_VALUE_LIMIT
): MetadataSummary {
  const keys = new Map<
    string,
    { types: Set<string>; documents: number; values: Map<string, number> }
  >();
  let documentsWithMetadata = 0;
  for (const json of input.metadata) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      continue;
    const entries = Object.entries(parsed);
    if (entries.length === 0) continue;
    documentsWithMetadata += 1;
    for (const [key, value] of entries) {
      const type = typeOf(value);
      if (!type) continue;
      const summary = keys.get(key) ?? {
        types: new Set<string>(),
        documents: 0,
        values: new Map<string, number>(),
      };
      summary.types.add(type);
      summary.documents += 1;
      const members = new Set(
        (Array.isArray(value) ? value : [value]).map((member) =>
          JSON.stringify(member)
        )
      );
      for (const member of members)
        summary.values.set(member, (summary.values.get(member) ?? 0) + 1);
      keys.set(key, summary);
    }
  }
  return {
    collection: input.collection,
    documents: input.documents,
    documentsWithMetadata,
    keys: [...keys.entries()]
      .map(([key, summary]) => {
        const values = [...summary.values.entries()].sort(
          ([leftText, left], [rightText, right]) =>
            right - left || (leftText < rightText ? -1 : 1)
        );
        return {
          key,
          types: [...summary.types].sort(),
          documents: summary.documents,
          values: values.slice(0, valueLimit).map(([text, documents]) => ({
            value: JSON.parse(text) as MetadataValue,
            documents,
          })),
          valuesTruncated: values.length > valueLimit,
        };
      })
      .sort(
        (left, right) =>
          right.documents - left.documents || (left.key < right.key ? -1 : 1)
      ),
  };
}

/** Shared read for every surface; `values` caps listed values per key. */
export async function readMetadataSummary(
  store: {
    getTypedMetadataDocuments(options?: {
      collection?: string;
    }): Promise<
      | { ok: true; value: { documents: number; metadata: string[] } }
      | { ok: false; error: { message: string } }
    >;
  },
  options: { collection?: string; values?: number } = {}
): Promise<MetadataSummary> {
  const values = options.values ?? DEFAULT_METADATA_VALUE_LIMIT;
  if (
    !Number.isInteger(values) ||
    values < 1 ||
    values > MAX_METADATA_VALUE_LIMIT
  )
    throw new RangeError(
      `values must be an integer from 1 to ${MAX_METADATA_VALUE_LIMIT}`
    );
  const result = await store.getTypedMetadataDocuments({
    collection: options.collection,
  });
  if (!result.ok) throw new Error(result.error.message);
  return summarizeTypedMetadata(
    { collection: options.collection ?? null, ...result.value },
    values
  );
}

/** Plain-text rendering shared by the CLI terminal output and MCP text. */
export function formatMetadataSummary(summary: MetadataSummary): string {
  const scope = summary.collection ? ` in ${summary.collection}` : "";
  const header = `${summary.documentsWithMetadata} of ${summary.documents} documents${scope} carry typed metadata`;
  if (summary.keys.length === 0) return `${header}.`;
  const lines = [`${header}:`, ""];
  for (const key of summary.keys) {
    const values = key.values
      .map((item) => `${JSON.stringify(item.value)} (${item.documents})`)
      .join(", ");
    lines.push(
      `${key.key} [${key.types.join(", ")}] ${key.documents} ${key.documents === 1 ? "doc" : "docs"}${values ? `: ${values}${key.valuesTruncated ? ", ..." : ""}` : ""}`
    );
  }
  return lines.join("\n");
}
