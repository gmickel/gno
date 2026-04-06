/**
 * Collection CRUD operations.
 * Pure functions that mutate config - caller handles I/O.
 *
 * @module src/collection
 */

export { addCollection } from "./add";
export { removeCollection } from "./remove";
export { updateCollection } from "./update";
export type {
  AddCollectionInput,
  CollectionError,
  CollectionResult,
  CollectionSuccess,
  RemoveCollectionInput,
  RenameCollectionInput,
  UpdateCollectionInput,
} from "./types";
