import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const contextCapsuleIndexSnapshotSchema = z
  .object({
    before: sha256Schema,
    after: sha256Schema,
    stable: z.literal(true),
  })
  .strict()
  .refine((value) => value.before === value.after, {
    message: "index changed while the operation was running",
    path: ["after"],
  });
