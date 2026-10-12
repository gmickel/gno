/** MCP collection egress policy and content-free audit management tools. */

import { z } from "zod";

import type { ToolContext } from "../server";

import { projectCollectionEgressPolicy } from "../../core/collection-egress-policy-projection";
import { CollectionEgressPolicyService } from "../../core/collection-egress-policy-service";
import { applyConfigChange } from "../../core/config-mutation";
import { EgressAuditService } from "../../core/egress-audit";
import { EGRESS_MAX_COLLECTIONS } from "../../core/egress-limits";
import { runTool, type ToolResult } from "./index";

const policy = z.enum(["local_only", "lan", "remote"]);

export const egressPolicyGetInputSchema = z
  .object({
    collection: z.string().min(1).max(64),
  })
  .strict();

export const egressPolicySetInputSchema = z
  .object({
    collection: z.string().min(1).max(64),
    policy,
    confirmation: z
      .object({
        collection: z.string().min(1).max(64),
        currentPolicy: policy,
        currentRevision: z.number().int().nonnegative(),
        targetPolicy: policy,
        acknowledged: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();

export const egressCheckInputSchema = z
  .object({
    collections: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(EGRESS_MAX_COLLECTIONS)
      .optional(),
    action: z.enum([
      "retrieve",
      "serve",
      "publish",
      "remote_inference",
      "export",
      "clip_write",
    ]),
    destinationZone: z.enum(["local_process", "loopback", "lan", "remote"]),
    caller: z
      .object({
        authenticated: z.boolean(),
        operationAuthorized: z.boolean(),
      })
      .strict(),
    contentClass: z.enum([
      "source",
      "snippet",
      "metadata",
      "attachment",
      "embedding",
      "capsule",
      "audit_log",
      "retrieval_trace",
    ]),
    partialResults: z.enum(["deny", "explicit"]).default("deny"),
  })
  .strict();

export const egressAuditListInputSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).default(100),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export const egressAuditIdInputSchema = z
  .object({
    auditId: z.string().min(1).max(128),
  })
  .strict();

export const egressAuditStatusInputSchema = z.object({}).strict();

export const egressAuditPurgeInputSchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

const json = (value: unknown): string => JSON.stringify(value, null, 2);

const unwrap = <T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string } }
): T => {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
};

const requireWrite = (ctx: ToolContext): void => {
  if (!ctx.enableWrite) {
    throw new Error(
      "WRITE_DISABLED: Egress policy and audit mutations require gateway.enableWrite or --mcp-enable-write"
    );
  }
};

export const handleEgressPolicyGet = (
  args: z.infer<typeof egressPolicyGetInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_policy_get",
    async () => {
      const state = new CollectionEgressPolicyService({
        getConfig: () => ctx.config,
      }).get(args.collection);
      if (!state.ok) throw new Error(`${state.code}: ${state.error}`);
      return state.value;
    },
    json
  );

export const handleEgressPolicySet = (
  args: z.infer<typeof egressPolicySetInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_policy_set",
    async () => {
      requireWrite(ctx);
      const service = new CollectionEgressPolicyService({
        getConfig: () => ctx.config,
        mutateConfig: (mutate) =>
          applyConfigChange(
            {
              store: ctx.store,
              configPath: ctx.actualConfigPath,
              onConfigUpdated: (config) => {
                ctx.config = config;
              },
              projectStore: (store, config) =>
                projectCollectionEgressPolicy(store, config, args.collection),
            },
            mutate
          ),
        onPolicyChanged: async () =>
          (await ctx.invalidateEgressPolicy?.()) ?? {
            policyEpoch: "egress-epoch-standalone",
            queuedJobsInvalidated: 0,
            sessionsInvalidated: 0,
            staleWorkMustRetry: true,
          },
      });
      const result = await service.set(args);
      if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
      const epoch = result.value.invalidation?.policyEpoch;
      if (epoch) ctx.advanceRequestAuthorizationEpoch?.(epoch);
      return result.value;
    },
    json
  );

export const handleEgressCheck = (
  args: z.infer<typeof egressCheckInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_check",
    async () => {
      const result = new CollectionEgressPolicyService({
        getConfig: () => ctx.config,
      }).explain(args);
      if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
      return result.value;
    },
    json
  );

export const handleEgressAuditList = (
  args: z.infer<typeof egressAuditListInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_audit_list",
    async () => unwrap(await new EgressAuditService(ctx.store).list(args)),
    json
  );

export const handleEgressAuditShow = (
  args: z.infer<typeof egressAuditIdInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_audit_show",
    async () =>
      unwrap(await new EgressAuditService(ctx.store).show(args.auditId)),
    json
  );

export const handleEgressAuditStatus = (
  _args: z.infer<typeof egressAuditStatusInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_audit_status",
    async () => unwrap(await new EgressAuditService(ctx.store).status()),
    json
  );

export const handleEgressAuditDelete = (
  args: z.infer<typeof egressAuditIdInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_audit_delete",
    async () => {
      requireWrite(ctx);
      return unwrap(
        await new EgressAuditService(ctx.store).delete(args.auditId)
      );
    },
    json
  );

export const handleEgressAuditPurge = (
  _args: z.infer<typeof egressAuditPurgeInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_egress_audit_purge",
    async () => {
      requireWrite(ctx);
      return unwrap(await new EgressAuditService(ctx.store).purge());
    },
    json
  );
