import type { ServerContext } from "./context";

/** Read-only compiled context adapters; caller authority comes from the socket. */
import {
  previewCompiledContext,
  checkCompiledContext,
} from "../app/compiled-context";
import {
  compiledContextPreviewInputSchema,
  compiledContextCheckInputSchema,
} from "../core/compiled-context";
import {
  isLocalClientRequest,
  type RequestPeerServer,
} from "./request-locality";

export async function handleCompiledContext(
  context: ServerContext,
  request: Request,
  server: RequestPeerServer | undefined,
  operation: "preview" | "check"
): Promise<Response> {
  try {
    // Bound bytes before JSON parsing, even when Content-Length is absent.
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json(
        { error: { code: "invalid_input", message: "JSON body required" } },
        { status: 400 }
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8 * 1024 * 1024 + 65536) {
        await reader.cancel();
        return Response.json(
          {
            error: {
              code: "invalid_input",
              message: "Compiled context request exceeds byte limit",
            },
          },
          { status: 413 }
        );
      }
      chunks.push(part.value);
    }
    const raw: unknown = JSON.parse(
      await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).text()
    );
    const input =
      operation === "preview"
        ? compiledContextPreviewInputSchema.parse(raw)
        : compiledContextCheckInputSchema.parse(raw);
    const local = isLocalClientRequest(request, server);
    const deps = {
      store: context.store,
      config: context.config,
      indexName: context.indexName,
      destinationZone: local ? ("local_process" as const) : ("remote" as const),
      caller: { authenticated: local, operationAuthorized: true },
    };
    const result =
      operation === "preview"
        ? await previewCompiledContext(input, deps)
        : await checkCompiledContext(input, deps);
    return Response.json(result);
  } catch {
    // Supplied Capsules may contain private metadata; errors never echo inputs.
    return Response.json(
      {
        error: {
          code: "compiled_context_unavailable",
          message:
            "Compiled context is invalid, stale, or unavailable for this caller",
        },
      },
      { status: 400 }
    );
  }
}
