import type { TypedMetadata } from "../core/typed-metadata";

import { METADATA_LIMITS, typedMetadataSchema } from "../core/typed-metadata";

const FRONTMATTER = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;
const GNO_KEY = /(?:^|[{,]\s*)(?:gno|"gno"|'gno')\s*:/m;
export interface TypedMetadataExtraction {
  typedMetadata?: TypedMetadata;
  metadataError?: string;
}

export function extractTypedMetadata(
  markdown: string
): TypedMetadataExtraction {
  const yaml = FRONTMATTER.exec(markdown)?.[1];
  if (yaml === undefined || !GNO_KEY.test(yaml)) return { typedMetadata: {} };
  if (new TextEncoder().encode(yaml).length > METADATA_LIMITS.bytes) {
    return {
      metadataError: "frontmatter: exceeds 64 KiB typed metadata parsing limit",
    };
  }
  // Bun.YAML aliases share object references rather than expanding copies.
  // The flat typed validator below rejects nested/cyclic values.
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch {
    // Malformed ordinary frontmatter keeps its existing search semantics.
    return GNO_KEY.test(yaml)
      ? { metadataError: "gno.metadata: invalid YAML" }
      : { typedMetadata: {} };
  }
  if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "gno"))
    return { typedMetadata: {} };
  const gno = (parsed as Record<string, unknown>).gno;
  if (!gno || typeof gno !== "object" || Array.isArray(gno)) {
    return { metadataError: "gno: expected a mapping" };
  }
  if (!Object.hasOwn(gno, "metadata")) return { typedMetadata: {} };
  return validateRecordMetadata((gno as Record<string, unknown>).metadata);
}

export function validateRecordMetadata(
  value: unknown,
  namespace = "gno.metadata"
): TypedMetadataExtraction {
  const parsed = typedMetadataSchema.safeParse(value);
  if (parsed.success) return { typedMetadata: parsed.data };
  const issue = parsed.error.issues[0];
  // Values may be private. Persist only the bounded field path, never input.
  return {
    metadataError:
      `${namespace}.${issue?.path.map(String).join(".") ?? ""}: invalid typed metadata`.slice(
        0,
        256
      ),
  };
}
