/**
 * Types for collection CRUD operations.
 *
 * @module src/collection/types
 */

import type { Collection, Config } from "../config/types";
import type { ModelType } from "../llm/types";

/**
 * Input for adding a collection.
 */
export interface AddCollectionInput {
  /** Absolute path to the folder */
  path: string;
  /** Collection name (will be lowercased) */
  name: string;
  /** File pattern (default: DEFAULT_PATTERN) */
  pattern?: string;
  /** Include patterns (comma-separated or array) */
  include?: string[] | string;
  /** Exclude patterns (comma-separated or array) */
  exclude?: string[] | string;
  /** Update command to run before sync */
  updateCmd?: string;
  /** Optional initial model overrides */
  models?: Partial<Record<ModelType, string>>;
}

/**
 * Input for removing a collection.
 */
export interface RemoveCollectionInput {
  /** Collection name (case-insensitive) */
  name: string;
}

/**
 * Input for renaming a collection.
 */
export interface RenameCollectionInput {
  /** Current collection name (case-insensitive) */
  oldName: string;
  /** New collection name (case-insensitive) */
  newName: string;
}

/**
 * Input for updating a collection.
 */
export interface UpdateCollectionInput {
  /** Collection name (case-insensitive) */
  name: string;
  /** Partial model override patch; null clears one role */
  models?: Partial<Record<ModelType, string | null>>;
}

/**
 * Successful collection operation result.
 */
export interface CollectionSuccess<T = Config> {
  ok: true;
  config: T;
  collection: Collection;
}

/**
 * Failed collection operation result.
 */
export interface CollectionError {
  ok: false;
  code:
    | "VALIDATION"
    | "NOT_FOUND"
    | "DUPLICATE"
    | "DUPLICATE_PATH"
    | "PATH_NOT_FOUND"
    | "HAS_REFERENCES";
  message: string;
}

export type CollectionResult<T = Config> =
  | CollectionSuccess<T>
  | CollectionError;
