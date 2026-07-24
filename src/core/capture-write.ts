/**
 * Shared capture write semantics.
 *
 * @module src/core/capture-write
 */

import type { CapturePlan } from "./capture";

import { atomicCreate, atomicWrite } from "./file-ops";

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "EEXIST"
  );
}

export async function writeCapturePlanFile(
  plan: CapturePlan,
  absPath: string
): Promise<void> {
  if (plan.provenanceConflict) {
    throw new Error(
      "Existing capture has different provenance. Use create_with_suffix or a different destination."
    );
  }
  try {
    if (plan.overwrite) {
      await atomicWrite(absPath, plan.content);
      return;
    }
    await atomicCreate(absPath, plan.content);
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(
        "File already exists. Use open_existing, create_with_suffix, or overwrite."
      );
    }
    throw error;
  }
}
