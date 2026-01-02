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
};
