/**
 * gno request-status: look up a write request ID before retrying it, plus
 * the CLI mapping for request receipt errors.
 *
 * @module src/cli/commands/request-status
 */

import { getIndexDbPath } from "../../app/constants";
import {
  formatRequestStatus,
  localRequestLedger,
  readRequestStatus,
  RequestReceiptError,
  type RequestReceiptErrorCode,
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
      ...localRequestLedger(getIndexDbPath(options.indexName)),
      requestId: options.requestId,
    });
  } catch (error) {
    throw requestErrorToCli(error);
  }
}

export function formatRequestStatusOutput(
  result: RequestStatusResult,
  options: { json?: boolean } = {}
): string {
  return options.json
    ? JSON.stringify(result, null, 2)
    : formatRequestStatus(result);
}
