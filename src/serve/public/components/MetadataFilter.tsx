import { useId, useState } from "react";

import { parseMetadataFilter } from "../lib/metadata-filter";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "all",
  "exists",
];

/** The JSON text is the single source of truth, including invalid drafts. */
export function MetadataFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const [draftLeaf, setDraftLeaf] = useState<Record<string, unknown> | null>(
    null
  );
  const { error } = parseMetadataFilter(value);
  let leaf: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "op" in parsed &&
      OPERATORS.includes(String(parsed.op))
    )
      leaf = parsed as Record<string, unknown>;
  } catch {
    /* Invalid JSON stays editable below. */
  }
  if (value.trim()) leaf ??= draftLeaf;
  const update = (patch: Record<string, unknown>) => {
    const next = { ...leaf, ...patch };
    setDraftLeaf(next);
    if (draftValue !== null) {
      const property = "values" in next ? "values" : "value";
      onChange(
        `{"op":${JSON.stringify(next.op)},"key":${JSON.stringify(next.key)},"${property}":${draftValue}}`
      );
    } else onChange(JSON.stringify(next));
  };
  return (
    <fieldset className="min-w-0 space-y-3 border-border/40 border-t pt-3">
      <legend className="px-1 font-mono text-muted-foreground text-xs">
        Custom metadata
      </legend>
      <p className="text-muted-foreground text-xs">
        Filter indexed gno.metadata fields. Text is case-sensitive. Values use
        JSON: "approved", 0.8, true, or ["alpha"]. Filters are included in this
        page’s URL.
      </p>
      {leaf ? (
        <div className="grid min-w-0 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-xs">
            Field
            <Input
              onChange={(e) => update({ key: e.target.value })}
              value={typeof leaf.key === "string" ? leaf.key : ""}
            />
          </label>
          <label className="space-y-1 text-xs">
            Operator
            <select
              className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 focus-visible:ring-2 focus-visible:ring-primary/50"
              onChange={(e) => {
                setDraftValue(null);
                setDraftLeaf(null);
                const op = e.target.value;
                onChange(
                  JSON.stringify({
                    op,
                    key: leaf?.key ?? "",
                    ...(["in", "nin", "all"].includes(op)
                      ? { values: [] }
                      : { value: op === "exists" ? true : "" }),
                  })
                );
              }}
              value={String(leaf.op)}
            >
              {OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Value (JSON)
            <Input
              onChange={(e) => {
                const raw = e.target.value;
                setDraftValue(raw);
                setDraftLeaf(leaf);
                const property = ["in", "nin", "all"].includes(String(leaf?.op))
                  ? "values"
                  : "value";
                // Preserve malformed JSON verbatim for correction; never drop the filter.
                onChange(
                  `{"op":${JSON.stringify(leaf?.op)},"key":${JSON.stringify(leaf?.key ?? "")},"${property}":${raw}}`
                );
              }}
              value={
                draftValue ??
                JSON.stringify("values" in leaf ? leaf.values : leaf.value) ??
                ""
              }
            />
          </label>
        </div>
      ) : !value.trim() ? (
        <Button
          onClick={() => {
            setDraftValue(null);
            setDraftLeaf(null);
            onChange(
              JSON.stringify({ op: "eq", key: "status", value: "approved" })
            );
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Add metadata filter
        </Button>
      ) : null}
      <label className="block space-y-1 text-xs" htmlFor={`${id}-json`}>
        Advanced filter (JSON)
        <Textarea
          aria-describedby={error ? `${id}-error` : undefined}
          aria-invalid={Boolean(error)}
          className="min-h-20 font-mono text-xs"
          id={`${id}-json`}
          onChange={(e) => {
            setDraftValue(null);
            setDraftLeaf(null);
            onChange(e.target.value);
          }}
          placeholder='{"op":"gte","key":"confidence","value":0.8}'
          value={value}
        />
      </label>
      {error && (
        <p
          className="break-words text-destructive text-xs"
          id={`${id}-error`}
          role="alert"
        >
          {error}
        </p>
      )}
      {value && (
        <Button
          onClick={() => {
            setDraftValue(null);
            setDraftLeaf(null);
            onChange("");
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Clear metadata filter
        </Button>
      )}
    </fieldset>
  );
}
