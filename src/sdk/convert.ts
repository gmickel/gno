/**
 * SDK conversion of one file to the Markdown GNO would index (no client,
 * config or index needed).
 *
 * @module src/sdk/convert
 */

import {
  type ConvertFileResult,
  convertFile as convertOneFile,
} from "../ingestion/convert-file";
import { sdkError } from "./errors";

/**
 * Convert one file to the Markdown GNO would index for it; nothing is
 * persisted. Failures throw `GnoSdkError` with `details.reason` set to the
 * same reason `gno convert` reports.
 */
export async function convertFile(path: string): Promise<ConvertFileResult> {
  const result = await convertOneFile(path);
  if (result.ok) return result.value;
  const { reason, message, validation, details } = result.error;
  let code: "NOT_FOUND" | "VALIDATION" | "RUNTIME" = "RUNTIME";
  if (reason === "NOT_FOUND") code = "NOT_FOUND";
  else if (validation) code = "VALIDATION";
  throw sdkError(code, message, { details: { reason, ...details } });
}
