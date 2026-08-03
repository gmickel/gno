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
  gno_backlinks: "metadata",
  gno_capture: "metadata",
  gno_changes: "metadata",
  gno_clear_collection_embeddings: "metadata",
  gno_context: "capsule",
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
  gno_remove_collection: "metadata",
  gno_rename_note: "metadata",
  gno_search: "snippet",
  gno_section: "metadata",
  gno_similar: "snippet",
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

const requestedCollections = (
  params: unknown,
  collections: readonly Collection[]
): string[] => {
  const record = asRecord(params);
  const args = asRecord(record?.arguments ?? params);
  if (!args) return collections.map(({ name }) => name);

  const names = new Set<string>();
  const direct = args.collection;
  if (typeof direct === "string") names.add(direct.trim().toLowerCase());
  for (const key of ["ref", "target", "from", "to", "root", "uri"]) {
    const collection = collectionFromRef(args[key]);
    if (collection) names.add(collection);
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
    // Trace export is authorized inside RetrievalTraceManagementService after
    // exact trace IDs resolve to their immutable collection lineage.
    if (name === "gno_trace_export") return;
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
