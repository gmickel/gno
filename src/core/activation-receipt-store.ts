import type {
  ActivationVerificationReceipt,
  StorePort,
  StoreResult,
} from "../store/types";

import { err, ok } from "../store/types";

/**
 * Persist a receipt only after the collection has been synchronized into the
 * store. Config can name a collection before its first sync creates the parent
 * row required by the receipt table's foreign key.
 */
export async function persistActivationReceiptForKnownCollection(
  store: StorePort,
  receipt: ActivationVerificationReceipt
): Promise<StoreResult<ActivationVerificationReceipt>> {
  const collections = await store.getCollections();
  if (!collections.ok) {
    return err(
      collections.error.code,
      collections.error.message,
      collections.error.cause
    );
  }
  if (!collections.value.some(({ name }) => name === receipt.collection)) {
    return ok(receipt);
  }

  const persisted = await store.upsertActivationReceipt(receipt);
  if (!persisted.ok) {
    return err(
      persisted.error.code,
      persisted.error.message,
      persisted.error.cause
    );
  }
  return ok(receipt);
}
