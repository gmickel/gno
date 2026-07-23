/** MCP tools for explicit local retrieval-trace management. */

import { z } from "zod";

import type {
  RetrievalTraceExportRequest,
  RetrievalTraceLabelRequest,
} from "../../core/retrieval-trace-management";
import type { StoreResult } from "../../store/types";
import type { ToolContext } from "../server";

import { withWriteLock } from "../../core/file-lock";
import { RetrievalTraceManagementService } from "../../core/retrieval-trace-management";
import { runTool, type ToolResult } from "./index";

export const traceListInputSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const traceShowInputSchema = z.object({
  traceId: z.string().min(1).max(128),
  detailLimit: z.number().int().min(1).max(5000).default(500),
});

export const traceLabelInputSchema = z.object({
  traceId: z.string().min(1).max(128),
  label: z.enum(["relevant", "irrelevant", "missing_expected"]),
  targetRef: z.string().min(1).max(4096),
  targetKind: z.enum(["document", "chunk", "span"]).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  docid: z.string().min(1).max(256).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
});

export const traceExportInputSchema = z.object({
  traceIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
  format: z.literal("agentic-receipt").default("agentic-receipt"),
});

export const traceDeleteInputSchema = z.object({
  traceId: z.string().min(1).max(128),
});

export const tracePurgeInputSchema = z.object({
  confirm: z.literal(true),
});

const unwrap = <T>(result: StoreResult<T>): T => {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
};

const jsonText = (value: unknown): string => JSON.stringify(value, null, 2);

const writeDisabled = (): never => {
  throw new Error(
    "WRITE_DISABLED: Trace mutations require gateway.enableWrite or --mcp-enable-write"
  );
};

export const handleTraceList = (
  args: z.infer<typeof traceListInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_trace_list",
    async () =>
      unwrap(await new RetrievalTraceManagementService(ctx.store).list(args)),
    jsonText
  );

export const handleTraceShow = (
  args: z.infer<typeof traceShowInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_trace_show",
    async () =>
      unwrap(
        await new RetrievalTraceManagementService(ctx.store).show(
          args.traceId,
          { detailLimit: args.detailLimit }
        )
      ),
    jsonText
  );

const runTraceWrite = <T>(
  ctx: ToolContext,
  name: string,
  operation: (
    service: RetrievalTraceManagementService
  ) => Promise<StoreResult<T>>
): Promise<ToolResult> =>
  runTool(
    ctx,
    name,
    async () => {
      if (!ctx.enableWrite) return writeDisabled();
      return withWriteLock(ctx.writeLockPath, async () =>
        unwrap(await operation(new RetrievalTraceManagementService(ctx.store)))
      );
    },
    jsonText
  );

export const handleTraceLabel = (
  args: z.infer<typeof traceLabelInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTraceWrite(ctx, "gno_trace_label", (service) =>
    service.label(args as RetrievalTraceLabelRequest)
  );

export const handleTraceExport = (
  args: z.infer<typeof traceExportInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTraceWrite(ctx, "gno_trace_export", (service) =>
    service.export(args as RetrievalTraceExportRequest)
  );

export const handleTraceDelete = (
  args: z.infer<typeof traceDeleteInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTraceWrite(ctx, "gno_trace_delete", (service) =>
    service.delete(args.traceId)
  );

export const handleTracePurge = (
  _args: z.infer<typeof tracePurgeInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTraceWrite(ctx, "gno_trace_purge", (service) => service.purge());
