/**
 * Standardized error codes/messages for MCP write operations.
 *
 * @module src/core/errors
 */

export const MCP_ERRORS = {
  LOCKED: {
    code: "LOCKED",
    message: "Another GNO write operation is running. Try again later.",
  },
  JOB_CONFLICT: {
    code: "JOB_CONFLICT",
    message: "Another job is already running.",
  },
  INVALID_PATH: {
    code: "INVALID_PATH",
    message: "Path violates safety rules.",
  },
  PATH_NOT_FOUND: {
    code: "PATH_NOT_FOUND",
    message: "Path not found.",
  },
  DUPLICATE: {
    code: "DUPLICATE",
    message: "Resource already exists.",
  },
  NOT_FOUND: {
    code: "NOT_FOUND",
    message: "Resource not found.",
  },
  CONFLICT: {
    code: "CONFLICT",
    message: "Conflict with existing resource.",
  },
  HAS_REFERENCES: {
    code: "HAS_REFERENCES",
    message: "Resource has references.",
  },
  INVALID_INPUT: {
    code: "INVALID_INPUT",
    message: "Invalid input.",
  },
};

/**
 * A tool failure that carries machine-readable details alongside its code.
 *
 * The MCP tool wrapper otherwise recovers a code by regex from a
 * `CODE: message` string, which forces a caller that needs to know WHY a write
 * was refused to parse prose. CLI, SDK, and REST all expose that reason
 * structurally; this is the same affordance for MCP.
 *
 * `message` keeps the `CODE: detail` shape so the text content of a tool error
 * is unchanged - only `structuredContent` gains the details.
 */
export class McpToolError extends Error {
  readonly code: string;
  /** The human-readable half, without the `CODE: ` prefix. */
  readonly detail: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, detail: string, details?: Record<string, unknown>) {
    super(`${code}: ${detail}`);
    this.name = "McpToolError";
    this.code = code;
    this.detail = detail;
    this.details = details;
  }
}
