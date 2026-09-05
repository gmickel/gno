/** Private development evidence, separate from the product IPC protocol. */
import { z } from "zod";

import type { NativeCapture } from "./capture-contract";

export const childIdentitySchema = z.strictObject({
  runId: z.string().min(1),
  token: z.string().uuid(),
  parentPid: z.number().int().positive(),
  pid: z.number().int().positive(),
  generation: z.number().int().positive(),
  entry: z.string().min(1),
});
export type ChildIdentity = z.infer<typeof childIdentitySchema>;
export const childReceiptSchema = z.strictObject({
  identity: childIdentitySchema,
  request: z
    .object({
      generation: z.number(),
      requestId: z.number().int().positive(),
      op: z.string(),
      modelId: z.string(),
    })
    .passthrough(),
  complete: z.boolean(),
  lifecycle: z.record(z.string(), z.number().finite()).optional(),
  capture: z
    .object({
      runId: z.string(),
      kind: z.literal("native"),
      modelInputs: z.array(
        z.object({
          role: z.enum(["embedding", "reranking", "generation"]),
          modelId: z.string(),
          input: z.json(),
        })
      ),
      modelOutputs: z.array(z.json()),
      backends: z.array(z.string()),
      models: z.array(
        z.object({ id: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      ),
      capabilities: z.array(
        z.object({
          capability: z.string(),
          status: z.string(),
          reasonCode: z.string().optional(),
        })
      ),
      errors: z.array(z.string()),
      contextEvents: z
        .array(
          z.object({
            modelId: z.string(),
            method: z.string(),
            arguments: z.json(),
            result: z.json().optional(),
          })
        )
        .optional(),
    })
    .strict(),
});
export type ChildReceipt = Omit<
  z.infer<typeof childReceiptSchema>,
  "capture"
> & { capture: NativeCapture };
export type ChildEvent = {
  identity: ChildIdentity;
  event: "birth" | "exit";
  exitCode?: number;
};

export function validateChildReceipt(
  value: unknown,
  identity: ChildIdentity,
  request: unknown
): ChildReceipt {
  const receipt = childReceiptSchema.parse(value);
  if (
    !Bun.deepEquals(receipt.identity, identity) ||
    !Bun.deepEquals(receipt.request, request) ||
    receipt.capture.runId !== identity.runId
  )
    throw new Error("Child capture request/owner identity mismatch");
  return receipt;
}

export function appendChildCapture(
  target: NativeCapture,
  receipt: ChildReceipt
): void {
  if (!receipt.complete)
    target.errors.push(
      `Incomplete native child request:${receipt.request.requestId}`
    );
  (target.contextEvents ??= []).push(...(receipt.capture.contextEvents ?? []));
  target.modelInputs.push(...receipt.capture.modelInputs);
  target.modelOutputs.push(...receipt.capture.modelOutputs);
  target.errors.push(...receipt.capture.errors);
  for (const backend of receipt.capture.backends)
    if (!target.backends.includes(backend)) target.backends.push(backend);
  for (const model of receipt.capture.models)
    if (
      !target.models.some(
        (item) => item.id === model.id && item.sha256 === model.sha256
      )
    )
      target.models.push(model);
}
