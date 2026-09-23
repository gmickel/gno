import { ZodError } from "zod";

import {
  normalizeMetadataPredicate,
  type MetadataPredicate,
} from "../../../core/typed-metadata";

export function parseMetadataFilter(text: string): {
  filter?: MetadataPredicate;
  error?: string;
} {
  if (!text.trim()) return {};
  try {
    return { filter: normalizeMetadataPredicate(JSON.parse(text)) };
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
      return {
        error: `filter${path}: ${issue?.message ?? "Invalid predicate"}. Check the operator, key, and JSON value type.`,
      };
    }
    return {
      error:
        "filter: Invalid JSON. Use quoted strings, finite numbers, booleans, or arrays of one type.",
    };
  }
}
