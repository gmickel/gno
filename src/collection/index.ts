/**
 * Collection CRUD operations.
 * Pure functions that mutate config - caller handles I/O.
 *
 * @module src/collection
 */

export { addCollection } from './add';
export { removeCollection } from './remove';
export type {
  AddCollectionInput,
  CollectionError,
  CollectionResult,
  CollectionSuccess,
  RemoveCollectionInput,
  RenameCollectionInput,
} from './types';
