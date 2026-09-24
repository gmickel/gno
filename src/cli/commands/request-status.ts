/**
 * gno request-status: look up a write request ID before retrying it, plus
 * the CLI mapping for request receipt errors.
 *
 * @module src/cli/commands/request-status
 */

import { getIndexDbPath } from "../../app/constants";
import {
  LOCAL_OWNER_NAMESPACE,
  readRequestStatus,
  RequestReceiptError,
  type RequestReceiptErrorCode,
  requestLedgerPath,
  type RequestStatusResult,
} from "../../core/request-receipts";
import { CliError, type CliErrorCode } from "../errors";

const REQUEST_ERROR_TO_CLI: Record<RequestReceiptErrorCode, CliErrorCode> = {
  REQUEST_ID_INVALID: "VALIDATION",
  REQUEST_ID_CONFLICT: "VALIDATION",
  REQUEST_EXPIRED: "VALIDATION",
  // Accepted and still in progress elsewhere: exit 4 like lease contention.
  REQUEST_PENDING: "BUSY",
  REQUEST_RECOVERY_CONFLICT: "RUNTIME",
  REQUEST_CAPACITY_EXHAUSTED: "RUNTIME",
  REQUEST_LEDGER_UNAVAILABLE: "RUNTIME",
};

/** Map a request receipt error onto the CLI error model (code in details). */
export function requestErrorToCli(error: unknown): unknown {
  if (!(error instanceof RequestReceiptError)) return error;
  return new CliError(REQUEST_ERROR_TO_CLI[error.code], error.message, {
    details: { requestCode: error.code },
  });
}

export async function requestStatus(options: {
  requestId: string;
  indexName?: string;
}): Promise<RequestStatusResult> {
  try {
    return await readRequestStatus({
      ledgerPath: requestLedgerPath(getIndexDbPath(options.indexName)),
      namespace: LOCAL_OWNER_NAMESPACE,
      requestId: options.requestId,
    });
  } catch (error) {
    throw requestErrorToCli(error);
  }
}

export function formatRequestStatus(
  result: RequestStatusResult,
  options: { json?: boolean } = {}
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  const lines = [`Request: ${result.requestId}`, `Status: ${result.status}`];
  if (result.operation) lines.push(`Operation: ${result.operation}`);
  if (result.updatedAt) lines.push(`Updated: ${result.updatedAt}`);
  if (result.result?.uri) lines.push(`URI: ${result.result.uri}`);
  const next: Record<RequestStatusResult["status"], string> = {
    committed: "Committed: do not resend; the retained outcome replays.",
    pending:
      "Pending: retry the same command with the same --request-id to finish it.",
    expired:
      "Expired: this ID already ran and will not run again; check current state before using a new ID.",
    not_found: "Not found: nothing was accepted under this ID.",
  };
  lines.push(next[result.status]);
  return lines.join("\n");
}
