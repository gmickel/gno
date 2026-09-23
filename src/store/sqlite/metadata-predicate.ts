import type {
  MetadataPredicate,
  MetadataScalar,
} from "../../core/typed-metadata";

import { normalizeMetadataPredicate } from "../../core/typed-metadata";

/** JSON keys and values are bound parameters, never paths or SQL fragments. */
export function compileMetadataPredicate(input: MetadataPredicate): {
  sql: string;
  params: (string | number)[];
} {
  const params: (string | number)[] = [];
  const bind = (value: string | number): string => {
    params.push(value);
    return "?";
  };
  const scalar = (alias: string, value: MetadataScalar): string => {
    const type =
      typeof value === "number"
        ? `${alias}.type IN ('integer','real')`
        : typeof value === "boolean"
          ? `${alias}.type IN ('true','false')`
          : `${alias}.type = 'text'`;
    return `(${type} AND ${alias}.value = ${bind(typeof value === "boolean" ? Number(value) : value)})`;
  };
  const compile = (node: MetadataPredicate): string => {
    if (node.op === "and" || node.op === "or")
      return `(${node.predicates.map(compile).join(node.op === "and" ? " AND " : " OR ")})`;
    if (node.op === "not") return `NOT (${compile(node.predicate)})`;
    if (!("key" in node)) throw new Error("Invalid metadata predicate");
    const key = bind(node.key);
    const select = `SELECT 1 FROM json_each(d.typed_metadata) mf WHERE mf.key = ${key}`;
    if (node.op === "exists")
      return `${node.value ? "" : "NOT "}EXISTS (${select})`;
    if ("values" in node) {
      if (node.op === "all") {
        const conditions = node.values.map(
          (value) =>
            `EXISTS (SELECT 1 FROM json_each(mf.value) mv WHERE ${scalar("mv", value)})`
        );
        return `EXISTS (${select} AND CASE WHEN mf.type = 'array' THEN (${conditions.join(" AND ")}) ELSE 0 END)`;
      }
      const arrayMatches = node.values
        .map((value) => scalar("mv", value))
        .join(" OR ");
      const scalarMatches = node.values
        .map((value) => scalar("mf", value))
        .join(" OR ");
      const match = `CASE WHEN mf.type = 'array' THEN EXISTS (SELECT 1 FROM json_each(mf.value) mv WHERE ${arrayMatches}) ELSE (${scalarMatches}) END`;
      return `EXISTS (${select} AND ${node.op === "nin" ? "NOT " : ""}(${match}))`;
    }
    if (node.op === "eq")
      return `EXISTS (${select} AND ${scalar("mf", node.value)})`;
    if (node.op === "ne") {
      const equal = scalar("mf", node.value);
      const type =
        typeof node.value === "number"
          ? "mf.type IN ('integer','real')"
          : typeof node.value === "boolean"
            ? "mf.type IN ('true','false')"
            : "mf.type = 'text'";
      return `EXISTS (${select} AND ${type} AND NOT ${equal})`;
    }
    if (typeof node.value !== "number")
      throw new Error("Ordering requires a number");
    const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
    return `EXISTS (${select} AND mf.type IN ('integer','real') AND mf.value ${operators[node.op]} ${bind(node.value)})`;
  };
  return { sql: compile(normalizeMetadataPredicate(input)), params };
}
