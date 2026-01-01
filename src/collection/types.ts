/**
 * Types for collection CRUD operations.
 *
 * @module src/collection/types
 */

import type { Collection, Config } from '../config/types';

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
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'DUPLICATE'
    | 'PATH_NOT_FOUND'
    | 'HAS_REFERENCES';
  message: string;
}

export type CollectionResult<T = Config> =
  | CollectionSuccess<T>
  | CollectionError;
