/** Checked callsite-level inventory of shipped network/process boundaries. */

import type { EgressAction } from "./egress-policy";

export type NetworkBoundaryPrimitive =
  | "bun_connect"
  | "bun_dns_lookup"
  | "bun_serve"
  | "child_process"
  | "event_source"
  | "fetch"
  | "http_inference"
  | "web_socket";

export interface NetworkBoundaryInventoryEntry {
  id: string;
  key: string;
  path: string;
  primitive: NetworkBoundaryPrimitive | "logical";
  action: EgressAction | null;
  enforcement:
    | "collection_policy"
    | "client_transport"
    | "disabled"
    | "local_process_only"
    | "loopback_only"
    | "no_collection_data";
  serverBoundary?: string;
}

export const NETWORK_BOUNDARY_INVENTORY = [
  {
    id: "daemon-listener",
    key: "src/cli/commands/daemon.ts::bun_serve#1",
    path: "src/cli/commands/daemon.ts",
    primitive: "bun_serve",
    action: "serve",
    enforcement: "collection_policy",
  },
  {
    id: "semantic-setup-process",
    key: "src/cli/commands/setup-semantic.ts::child_process#1",
    path: "src/cli/commands/setup-semantic.ts",
    primitive: "child_process",
    action: null,
    enforcement: "no_collection_data",
  },
  {
    id: "detached-runtime-process",
    key: "src/cli/detach.ts::child_process#1",
    path: "src/cli/detach.ts",
    primitive: "child_process",
    action: null,
    enforcement: "no_collection_data",
  },
  {
    id: "detached-runtime-health",
    key: "src/cli/detach.ts::fetch#1",
    path: "src/cli/detach.ts",
    primitive: "fetch",
    action: null,
    enforcement: "no_collection_data",
  },
  {
    id: "terminal-pager",
    key: "src/cli/pager.ts::child_process#1",
    path: "src/cli/pager.ts",
    primitive: "child_process",
    action: null,
    enforcement: "local_process_only",
  },
  {
    id: "file-lock-process-probe",
    key: "src/core/file-lock.ts::child_process#1",
    path: "src/core/file-lock.ts",
    primitive: "child_process",
    action: null,
    enforcement: "no_collection_data",
  },
  {
    id: "local-file-operations",
    key: "src/core/file-ops.ts::child_process#1",
    path: "src/core/file-ops.ts",
    primitive: "child_process",
    action: null,
    enforcement: "local_process_only",
  },
  {
    id: "sync-update-command",
    key: "src/ingestion/sync.ts::child_process#1",
    path: "src/ingestion/sync.ts",
    primitive: "child_process",
    action: "export",
    enforcement: "collection_policy",
  },
  {
    id: "sync-git-repository-check",
    key: "src/ingestion/sync.ts::child_process#2",
    path: "src/ingestion/sync.ts",
    primitive: "child_process",
    action: null,
    enforcement: "local_process_only",
  },
  {
    id: "sync-git-pull",
    key: "src/ingestion/sync.ts::child_process#3",
    path: "src/ingestion/sync.ts",
    primitive: "child_process",
    action: "export",
    enforcement: "collection_policy",
  },
  {
    id: "inference-dns-classification",
    key: "src/llm/http-policy.ts::bun_dns_lookup#1",
    path: "src/llm/http-policy.ts",
    primitive: "bun_dns_lookup",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    id: "http-embedding-single",
    key: "src/llm/httpEmbedding.ts::http_inference#1",
    path: "src/llm/httpEmbedding.ts",
    primitive: "http_inference",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    id: "http-embedding-batch",
    key: "src/llm/httpEmbedding.ts::http_inference#2",
    path: "src/llm/httpEmbedding.ts",
    primitive: "http_inference",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    id: "http-generation",
    key: "src/llm/httpGeneration.ts::http_inference#1",
    path: "src/llm/httpGeneration.ts",
    primitive: "http_inference",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    id: "http-rerank",
    key: "src/llm/httpRerank.ts::http_inference#1",
    path: "src/llm/httpRerank.ts",
    primitive: "http_inference",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    // Collection text crosses owned local IPC only. The child receives approved
    // model paths and a restricted environment with downloads/builds disabled.
    id: "native-inference-worker",
    key: "src/llm/native-worker/client.ts::child_process#1",
    path: "src/llm/native-worker/client.ts",
    primitive: "child_process",
    action: null,
    enforcement: "local_process_only",
  },
  {
    id: "pinned-http-fetch",
    key: "src/llm/pinned-http-connection.ts::fetch#1",
    path: "src/llm/pinned-http-connection.ts",
    primitive: "fetch",
    action: "remote_inference",
    enforcement: "collection_policy",
  },
  {
    id: "browser-blob-read",
    key: "src/serve/public/components/ai-elements/prompt-input.tsx::fetch#1",
    path: "src/serve/public/components/ai-elements/prompt-input.tsx",
    primitive: "fetch",
    action: null,
    enforcement: "local_process_only",
  },
  {
    id: "browser-api-hook",
    key: "src/serve/public/hooks/use-api.ts::fetch#1",
    path: "src/serve/public/hooks/use-api.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "client_transport",
    serverBoundary: "src/serve/server.ts",
  },
  {
    id: "browser-api-helper",
    key: "src/serve/public/hooks/use-api.ts::fetch#2",
    path: "src/serve/public/hooks/use-api.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "client_transport",
    serverBoundary: "src/serve/server.ts",
  },
  {
    id: "browser-document-events",
    key: "src/serve/public/hooks/use-doc-events.ts::event_source#1",
    path: "src/serve/public/hooks/use-doc-events.ts",
    primitive: "event_source",
    action: "serve",
    enforcement: "client_transport",
    serverBoundary: "src/serve/server.ts",
  },
  {
    // Same-origin HEAD against /api/doc-asset to pick the PDF transport tier.
    id: "browser-pdf-transport-probe",
    key: "src/serve/public/hooks/use-pdf-document.ts::fetch#1",
    path: "src/serve/public/hooks/use-pdf-document.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "client_transport",
    serverBoundary: "src/serve/routes/api.ts",
  },
  {
    id: "clipper-pair-csrf",
    key: "src/serve/public/lib/clipper-approval.ts::fetch#1",
    path: "src/serve/public/lib/clipper-approval.ts",
    primitive: "fetch",
    action: "clip_write",
    enforcement: "client_transport",
    serverBoundary: "src/serve/routes/clipper.ts",
  },
  {
    id: "clipper-pair-approval",
    key: "src/serve/public/lib/clipper-approval.ts::fetch#2",
    path: "src/serve/public/lib/clipper-approval.ts",
    primitive: "fetch",
    action: "clip_write",
    enforcement: "client_transport",
    serverBoundary: "src/serve/routes/clipper.ts",
  },
  {
    id: "serve-listener",
    key: "src/serve/server.ts::bun_serve#1",
    path: "src/serve/server.ts",
    primitive: "bun_serve",
    action: "serve",
    enforcement: "loopback_only",
  },
  {
    // Loopback self-request that warms the SPA shell cache from the server's
    // own bound port (127.0.0.1). Carries no collection data and never leaves
    // the host.
    id: "serve-spa-shell",
    key: "src/serve/server.ts::fetch#1",
    path: "src/serve/server.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "loopback_only",
  },
  {
    // Windows-only private SPA bundle listener. Bun does not support Unix
    // sockets on Windows, so this binds an ephemeral loopback port instead.
    id: "serve-spa-bundle-windows-listener",
    key: "src/serve/spa-bundle-source.ts::bun_serve#1",
    path: "src/serve/spa-bundle-source.ts",
    primitive: "bun_serve",
    action: "serve",
    enforcement: "loopback_only",
  },
  {
    // Unix-only private SPA bundle listener. The generated assets are exposed
    // through a process-owned Unix-domain socket, never a TCP interface.
    id: "serve-spa-bundle-unix-listener",
    key: "src/serve/spa-bundle-source.ts::bun_serve#2",
    path: "src/serve/spa-bundle-source.ts",
    primitive: "bun_serve",
    action: "serve",
    enforcement: "local_process_only",
  },
  {
    // Windows-only request from the public server to its private, ephemeral
    // loopback SPA bundle listener.
    id: "serve-spa-bundle-windows-fetch",
    key: "src/serve/spa-bundle-source.ts::fetch#1",
    path: "src/serve/spa-bundle-source.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "loopback_only",
  },
  {
    // Unix-only request over the process-owned SPA bundle socket. The HTTP URL
    // is a Bun fetch API requirement; the request is routed through `unix`.
    id: "serve-spa-bundle-unix-fetch",
    key: "src/serve/spa-bundle-source.ts::fetch#2",
    path: "src/serve/spa-bundle-source.ts",
    primitive: "fetch",
    action: "serve",
    enforcement: "local_process_only",
  },
  {
    id: "http-mcp-tools",
    key: "logical::http-mcp-tools",
    path: "src/mcp/http-egress.ts",
    primitive: "logical",
    action: "serve",
    enforcement: "collection_policy",
  },
  {
    id: "http-mcp-resources",
    key: "logical::http-mcp-resources",
    path: "src/mcp/http-egress.ts",
    primitive: "logical",
    action: "serve",
    enforcement: "collection_policy",
  },
  {
    id: "local-publish-artifact",
    key: "logical::local-publish-artifact",
    path: "src/publish/export-service.ts",
    primitive: "logical",
    action: "export",
    enforcement: "local_process_only",
  },
  {
    id: "remote-publish-upload",
    key: "logical::remote-publish-upload",
    path: "src/publish/export-service.ts",
    primitive: "logical",
    action: null,
    enforcement: "disabled",
  },
  {
    id: "private-agent-access",
    key: "logical::private-agent-access",
    path: "src/publish/encrypted-export.ts",
    primitive: "logical",
    action: null,
    enforcement: "disabled",
  },
] as const satisfies readonly NetworkBoundaryInventoryEntry[];
