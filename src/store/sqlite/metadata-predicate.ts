import type {
  MetadataPredicate,
  MetadataScalar,
} from "../../core/typed-metadata";

import { normalizeMetadataPredicate } from "../../core/typed-metadata";

const SIMPLE_JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const typeClause = (typeExpr: string, sample: MetadataScalar): string => {
    if (typeof sample === "number") return `${typeExpr} IN ('integer','real')`;
    if (typeof sample === "boolean") return `${typeExpr} IN ('true','false')`;
    return `${typeExpr} = 'text'`;
  };
  const scalarEq = (
    typeExpr: string,
    valExpr: string,
    value: MetadataScalar
  ): string => {
    if (typeof value === "boolean") {
      return `${typeExpr} = '${value ? "true" : "false"}'`;
    }
    return `(${typeClause(typeExpr, value)} AND ${valExpr} = ${bind(value)})`;
  };
  const valuesMatch = (
    typeExpr: string,
    valExpr: string,
    values: MetadataScalar[]
  ): string => {
    const first = values[0]!;
    if (typeof first === "boolean") {
      const wantTrue = values.includes(true);
      const wantFalse = values.includes(false);
      if (wantTrue && wantFalse) return `${typeExpr} IN ('true','false')`;
      return `${typeExpr} = '${wantTrue ? "true" : "false"}'`;
    }
    if (values.length === 1) {
      return scalarEq(typeExpr, valExpr, first);
    }
    const placeholders = values
      .map((v) => bind(v as string | number))
      .join(",");
    return `(${typeClause(typeExpr, first)} AND ${valExpr} IN (${placeholders}))`;
  };
  const allMatch = (
    arrayExpr: string,
    values: MetadataScalar[],
    pathParam?: string
  ): string => {
    const first = values[0]!;
    const eachCall = pathParam
      ? `json_each(${arrayExpr}, ${pathParam})`
      : `json_each(${arrayExpr})`;
    if (typeof first === "boolean") {
      const wantTrue = values.includes(true);
      const wantFalse = values.includes(false);
      const needed = (wantTrue ? 1 : 0) + (wantFalse ? 1 : 0);
      const cond =
        wantTrue && wantFalse
          ? "mv.type IN ('true','false')"
          : `mv.type = '${wantTrue ? "true" : "false"}'`;
      return `(SELECT COUNT(DISTINCT mv.type) FROM ${eachCall} mv WHERE ${cond}) = ${needed}`;
    }
    const placeholders = values
      .map((v) => bind(v as string | number))
      .join(",");
    return `(SELECT COUNT(DISTINCT mv.value) FROM ${eachCall} mv WHERE ${typeClause("mv.type", first)} AND mv.value IN (${placeholders})) = ${values.length}`;
  };

  const compile = (node: MetadataPredicate): string => {
    if (node.op === "and" || node.op === "or")
      return `(${node.predicates.map(compile).join(node.op === "and" ? " AND " : " OR ")})`;
    if (node.op === "not") return `NOT (${compile(node.predicate)})`;
    if (!("key" in node)) throw new Error("Invalid metadata predicate");

    // Fast path for safe unquoted identifier keys: bound JSON path parameter
    // avoids scanning every key in d.typed_metadata with json_each().
    // COALESCE(..., 0) / IS keeps every leaf 2-valued (0/1, never NULL) so
    // outer NOT(...) behaves identically to NOT EXISTS(...) when keys are absent.
    if (SIMPLE_JSON_KEY.test(node.key)) {
      const path = `$.${node.key}`;
      if (node.op === "exists") {
        const p = bind(path);
        return `json_type(d.typed_metadata, ${p}) IS ${node.value ? "NOT NULL" : "NULL"}`;
      }
      if ("values" in node) {
        if (node.op === "all") {
          const pType = bind(path);
          const pEach = bind(path);
          return `(json_type(d.typed_metadata, ${pType}) IS 'array' AND ${allMatch("d.typed_metadata", node.values, pEach)})`;
        }
        const pPresent = bind(path);
        const pType = bind(path);
        const pEach = bind(path);
        const arrayMatch = `EXISTS (SELECT 1 FROM json_each(d.typed_metadata, ${pEach}) mv WHERE ${valuesMatch("mv.type", "mv.value", node.values)})`;
        const pScalarType = bind(path);
        const scalarMatch =
          typeof node.values[0] === "boolean"
            ? `COALESCE(${valuesMatch(`json_type(d.typed_metadata, ${pScalarType})`, "", node.values)}, 0)`
            : `COALESCE(${valuesMatch(`json_type(d.typed_metadata, ${pScalarType})`, `json_extract(d.typed_metadata, ${bind(path)})`, node.values)}, 0)`;
        const match = `CASE WHEN json_type(d.typed_metadata, ${pType}) IS 'array' THEN ${arrayMatch} ELSE ${scalarMatch} END`;
        return `(json_type(d.typed_metadata, ${pPresent}) IS NOT NULL AND ${node.op === "nin" ? "NOT " : ""}(${match}))`;
      }
      if (node.op === "eq") {
        const pType = bind(path);
        if (typeof node.value === "boolean") {
          return `json_type(d.typed_metadata, ${pType}) IS '${node.value ? "true" : "false"}'`;
        }
        const pVal = bind(path);
        return `COALESCE(${scalarEq(`json_type(d.typed_metadata, ${pType})`, `json_extract(d.typed_metadata, ${pVal})`, node.value)}, 0)`;
      }
      if (node.op === "ne") {
        const pType = bind(path);
        if (typeof node.value === "boolean") {
          return `json_type(d.typed_metadata, ${pType}) IS '${node.value ? "false" : "true"}'`;
        }
        const pVal = bind(path);
        return `COALESCE(${typeClause(`json_type(d.typed_metadata, ${pType})`, node.value)} AND json_extract(d.typed_metadata, ${pVal}) != ${bind(node.value)}, 0)`;
      }
      if (typeof node.value !== "number")
        throw new Error("Ordering requires a number");
      const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
      const pType = bind(path);
      const pVal = bind(path);
      return `COALESCE(json_type(d.typed_metadata, ${pType}) IN ('integer','real') AND json_extract(d.typed_metadata, ${pVal}) ${operators[node.op]} ${bind(node.value)}, 0)`;
    }

    // Fallback for keys with punctuation/quotes: exact key lookup via json_each.
    const key = bind(node.key);
    const select = `SELECT 1 FROM json_each(d.typed_metadata) mf WHERE mf.key = ${key}`;
    if (node.op === "exists")
      return `${node.value ? "" : "NOT "}EXISTS (${select})`;
    if ("values" in node) {
      if (node.op === "all") {
        return `EXISTS (${select} AND CASE WHEN mf.type = 'array' THEN ${allMatch("mf.value", node.values)} ELSE 0 END)`;
      }
      const arrayMatches = valuesMatch("mv.type", "mv.value", node.values);
      const scalarMatches = valuesMatch("mf.type", "mf.value", node.values);
      const match = `CASE WHEN mf.type = 'array' THEN EXISTS (SELECT 1 FROM json_each(mf.value) mv WHERE ${arrayMatches}) ELSE (${scalarMatches}) END`;
      return `EXISTS (${select} AND ${node.op === "nin" ? "NOT " : ""}(${match}))`;
    }
    if (node.op === "eq")
      return `EXISTS (${select} AND ${scalarEq("mf.type", "mf.value", node.value)})`;
    if (node.op === "ne") {
      if (typeof node.value === "boolean") {
        return `EXISTS (${select} AND mf.type = '${node.value ? "false" : "true"}')`;
      }
      return `EXISTS (${select} AND ${typeClause("mf.type", node.value)} AND mf.value != ${bind(node.value)})`;
    }
    if (typeof node.value !== "number")
      throw new Error("Ordering requires a number");
    const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
    return `EXISTS (${select} AND mf.type IN ('integer','real') AND mf.value ${operators[node.op]} ${bind(node.value)})`;
  };
  return { sql: compile(normalizeMetadataPredicate(input)), params };
}
