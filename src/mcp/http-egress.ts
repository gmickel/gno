/** Per-request egress authorization for the resident HTTP MCP boundary. */

import type { Collection } from "../config/types";
import type {
  EgressContentClass,
  EgressDestinationZone,
} from "../core/egress-policy";

import { parseUri } from "../app/constants";
import {
  collectionEgressStates,
  EGRESS_DENIED_MESSAGE,
  EgressDeniedError,
} from "../core/egress-enforcement";
import { evaluateEgressPolicy } from "../core/egress-policy";

export const MCP_HTTP_EGRESS_TOOLS = {
  gno_add_collection: "metadata",
  gno_ask: "capsule",
  gno_audit: "metadata",
  gno_backlinks: "metadata",
  gno_capture: "metadata",
  gno_changes: "metadata",
  gno_clear_collection_embeddings: "metadata",
  gno_context: "capsule",
  gno_context_compiled_preview: "capsule",
  gno_context_compiled_check: "capsule",
  gno_context_verify: "capsule",
  gno_create_folder: "metadata",
  gno_diff: "metadata",
  gno_duplicate_note: "metadata",
  gno_embed: "metadata",
  gno_egress_audit_delete: "audit_log",
  gno_egress_audit_list: "audit_log",
  gno_egress_audit_purge: "audit_log",
  gno_egress_audit_show: "audit_log",
  gno_egress_audit_status: "audit_log",
  gno_egress_check: "audit_log",
  gno_egress_policy_get: "metadata",
  gno_egress_policy_set: "metadata",
  gno_get: "source",
  gno_graph: "metadata",
  gno_graph_neighbors: "metadata",
  gno_graph_path: "metadata",
  gno_graph_query: "metadata",
  gno_impact: "metadata",
  gno_index: "metadata",
  gno_job_status: "metadata",
  gno_links: "metadata",
  gno_list_jobs: "metadata",
  gno_list_tags: "metadata",
  gno_move_note: "metadata",
  gno_multi_get: "source",
  gno_query: "snippet",
  gno_query_diagnose: "metadata",
  gno_recall: "source",
  gno_remember: "source",
  gno_remove_collection: "metadata",
  gno_rename_note: "metadata",
  gno_request_status: "metadata",
  gno_search: "snippet",
  gno_section: "metadata",
  gno_sessions_automation_run: "metadata",
  gno_sessions_import: "metadata",
  gno_sessions_status: "metadata",
  gno_similar: "snippet",
  gno_peek: "metadata",
  gno_status: "metadata",
  gno_sync: "metadata",
  gno_trace_delete: "retrieval_trace",
  gno_trace_export: "retrieval_trace",
  gno_trace_label: "retrieval_trace",
  gno_trace_list: "retrieval_trace",
  gno_trace_purge: "retrieval_trace",
  gno_trace_show: "retrieval_trace",
  gno_vsearch: "snippet",
} as const satisfies Record<string, EgressContentClass>;

export const MCP_HTTP_EGRESS_METHODS = {
  "resources/list": "metadata",
  "resources/read": "source",
  "resources/templates/list": "metadata",
} as const satisfies Record<string, EgressContentClass>;

export interface HttpMcpEgressContext {
  authenticated: boolean;
  destinationZone: EgressDestinationZone;
  operationAuthorized: boolean;
}

interface JsonRpcMessage {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export class HttpMcpEgressDeniedError extends EgressDeniedError {
  readonly requestId: unknown;

  constructor(error: EgressDeniedError, requestId: unknown) {
    super(error.decision);
    this.name = "HttpMcpEgressDeniedError";
    this.requestId = requestId;
  }
}

const SYSTEM_EGRESS_STATE = {
  collection: "system",
  policy: "local_only",
  source: "config_default",
} as const;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const collectionFromRef = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parsed = parseUri(value);
  if (parsed) return parsed.collection;
  const slash = value.indexOf("/");
  if (slash <= 0 || value.startsWith("#")) return null;
  return value.slice(0, slash).trim().toLowerCase() || null;
};

/**
 * Tools whose results follow resolved graph edges. Links resolve across a
 * link workspace, so a ref's own collection does not bound the result: the
 * scope is the explicit collection argument (else every collection) plus the
 * collection of every referenced document.
 */
const GRAPH_RESULT_TOOLS = new Set([
  "gno_backlinks",
  "gno_graph",
  "gno_graph_neighbors",
  "gno_graph_path",
  "gno_graph_query",
  "gno_impact",
]);

const requestedCollections = (
  params: unknown,
  collections: readonly Collection[]
): string[] => {
  const record = asRecord(params);
  const args = asRecord(record?.arguments ?? params);
  if (!args) return collections.map(({ name }) => name);

  const names = new Set<string>();
  const direct = args.collection;
  // Handlers treat a blank collection as omitted, so it must not count as a
  // scope here either (a graph call with one is authorized as unscoped).
  if (typeof direct === "string" && direct.trim())
    names.add(direct.trim().toLowerCase());
  if (
    (record?.name === "gno_audit" || record?.name === "gno_impact") &&
    Array.isArray(args.collections)
  ) {
    for (const value of args.collections) {
      if (typeof value !== "string") continue;
      const normalized = value.trim().toLowerCase();
      if (normalized) names.add(normalized);
    }
  }
  const graphTool =
    typeof record?.name === "string" && GRAPH_RESULT_TOOLS.has(record.name);
  // A graph result spans every collection a link resolves into: without an
  // explicit scope, authorize them all.
  // `gno_similar` with crossCollection returns documents from every collection.
  const crossCollectionSimilar =
    record?.name === "gno_similar" && args.crossCollection === true;
  if ((graphTool && names.size === 0) || crossCollectionSimilar) {
    for (const { name } of collections) names.add(name);
  }
  // The referenced documents' own collections are always authorized too:
  // graph tools serialize the target's metadata even when the result scope
  // is narrower. A graph-tool ref whose collection cannot be read without
  // the index (a docid) authorizes every collection (fail closed).
  for (const key of ["ref", "target", "from", "to", "root", "uri"]) {
    const value = args[key];
    const collection = collectionFromRef(value);
    if (collection) names.add(collection);
    else if (graphTool && typeof value === "string" && value.trim()) {
      for (const { name } of collections) names.add(name);
    }
  }
  if (Array.isArray(args.refs)) {
    for (const ref of args.refs) {
      const collection = collectionFromRef(ref);
      if (collection) names.add(collection);
    }
  }
  return names.size > 0 ? [...names] : collections.map(({ name }) => name);
};

const enforceMessage = (
  message: JsonRpcMessage,
  collections: readonly Collection[],
  context: HttpMcpEgressContext
): void => {
  let contentClass: EgressContentClass | undefined;
  if (message.method === "tools/call") {
    const params = asRecord(message.params);
    const name = params?.name;
    if (typeof name !== "string" || !(name in MCP_HTTP_EGRESS_TOOLS)) return;
    // Derived exports authorize exact current lineage inside their shared
    // runtime. Broad transport scoping would deny eligible subsets merely
    // because another configured collection is private.
    if (
      name === "gno_trace_export" ||
      name === "gno_context_compiled_preview" ||
      name === "gno_context_compiled_check"
    )
      return;
    contentClass =
      MCP_HTTP_EGRESS_TOOLS[name as keyof typeof MCP_HTTP_EGRESS_TOOLS];
  } else if (
    typeof message.method === "string" &&
    message.method in MCP_HTTP_EGRESS_METHODS
  ) {
    contentClass =
      MCP_HTTP_EGRESS_METHODS[
        message.method as keyof typeof MCP_HTTP_EGRESS_METHODS
      ];
  } else {
    return;
  }

  const names = requestedCollections(message.params, collections);
  const scoped = collectionEgressStates(collections, names);
  const decision = evaluateEgressPolicy({
    collections: scoped.length > 0 ? scoped : [SYSTEM_EGRESS_STATE],
    action: "serve",
    destination: { zone: context.destinationZone },
    caller: {
      authenticated: context.authenticated,
      operationAuthorized: context.operationAuthorized,
    },
    contentClass,
  });
  if (!decision.allowed) {
    throw new HttpMcpEgressDeniedError(
      new EgressDeniedError(decision),
      message.id
    );
  }
};

export const enforceHttpMcpEgress = (
  payload: unknown,
  collections: readonly Collection[],
  context: HttpMcpEgressContext
): void => {
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const value of messages) {
    const message = asRecord(value);
    if (message) enforceMessage(message, collections, context);
  }
};

export const httpMcpEgressDeniedResponse = (
  error: EgressDeniedError,
  payload: unknown
): Response => {
  const first = Array.isArray(payload) ? payload[0] : payload;
  const id =
    error instanceof HttpMcpEgressDeniedError
      ? (error.requestId ?? null)
      : (asRecord(first)?.id ?? null);
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32_003,
        message: EGRESS_DENIED_MESSAGE,
        data: error.toJSON(),
      },
      id,
    },
    { status: 403 }
  );
};
