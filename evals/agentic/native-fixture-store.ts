// node:fs/promises: immutable fixture-index cleanup has no Bun directory API.
import { rm } from "node:fs/promises";

import type { StorePort } from "../../src/store/types";
import type { AdapterPreparation, AdapterPrepareContext } from "./adapter";
import type {
  CorpusSnapshot,
  NativeIndexPreparation,
  TimingObservation,
} from "./types";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { SqliteAdapter } from "../../src/store";
import {
  AgenticHarnessError,
  measuredTiming,
  unavailableTiming,
} from "./adapter";
import { prepareGnoNativeIndex } from "./native-index";

const HANDLE_KIND = "gno-agentic-native-fixture-index-v1" as const;

interface NativeFixtureHandle {
  kind: typeof HANDLE_KIND;
  native: NativeIndexPreparation;
}

const isNativeFixtureHandle = (value: unknown): value is NativeFixtureHandle =>
  Boolean(
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === HANDLE_KIND &&
    (value as { native?: unknown }).native
  );

const mustStore = <T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
  action: string
): T => {
  if (!result.ok) {
    throw new AgenticHarnessError(
      "native_fixture_store_failed",
      `${action}: ${result.error.message}`
    );
  }
  return result.value;
};

export interface NativeFixtureResetResult {
  startup: TimingObservation;
  modelLoad: TimingObservation;
  diagnostics: string[];
}

/**
 * Owns one adapter instance's connection to an immutable, prebuilt GNO index.
 * The preparation owner deletes the temp root only after every attached trial
 * instance has been disposed by the runner.
 */
export class NativeFixtureStoreLifecycle {
  private snapshot: CorpusSnapshot | null = null;
  private handle: NativeFixtureHandle | null = null;
  private store: SqliteAdapter | null = null;
  private ownsPreparation = false;

  constructor(private readonly adapterId: string) {}

  async prepare(context: AdapterPrepareContext): Promise<AdapterPreparation> {
    if (context.signal.aborted) throw context.signal.reason;
    this.snapshot = context.snapshot;
    if (context.prepared) return this.attach(context.prepared);

    const native = await prepareGnoNativeIndex(context.snapshot);
    if (context.signal.aborted) {
      await rm(native.rootPath, { force: true, recursive: true });
      throw context.signal.reason;
    }
    this.handle = { kind: HANDLE_KIND, native };
    this.ownsPreparation = true;
    return this.toPreparation(
      measuredTiming(native.observations.preparationMs)
    );
  }

  async reset(signal: AbortSignal): Promise<NativeFixtureResetResult> {
    if (signal.aborted) throw signal.reason;
    if (!this.handle) {
      throw new AgenticHarnessError(
        "native_fixture_not_prepared",
        "Native fixture index is not attached"
      );
    }
    if (this.store) {
      return {
        startup: measuredTiming(0),
        modelLoad: unavailableTiming("lexical adapters do not load models"),
        diagnostics: [],
      };
    }
    const started = performance.now();
    const store = new SqliteAdapter();
    mustStore(
      await store.open(this.handle.native.dbPath, DEFAULT_FTS_TOKENIZER),
      "open native fixture index"
    );
    if (signal.aborted) {
      await store.close();
      throw signal.reason;
    }
    this.store = store;
    return {
      startup: measuredTiming(performance.now() - started),
      modelLoad: unavailableTiming("lexical adapters do not load models"),
      diagnostics: [],
    };
  }

  getStore(): StorePort {
    if (!this.store) {
      throw new AgenticHarnessError(
        "native_fixture_store_closed",
        "Native fixture store is not open"
      );
    }
    return this.store;
  }

  getSnapshot(): CorpusSnapshot {
    if (!this.snapshot) {
      throw new AgenticHarnessError(
        "native_fixture_not_prepared",
        "Native fixture snapshot is not attached"
      );
    }
    return this.snapshot;
  }

  getIndexFingerprint(): string {
    if (!this.handle) {
      throw new AgenticHarnessError(
        "native_fixture_not_prepared",
        "Native fixture index is not attached"
      );
    }
    return this.handle.native.indexFingerprint;
  }

  async dispose(): Promise<void> {
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
    if (this.ownsPreparation && this.handle) {
      await rm(this.handle.native.rootPath, { force: true, recursive: true });
    }
    this.handle = null;
    this.snapshot = null;
    this.ownsPreparation = false;
  }

  private attach(prepared: AdapterPreparation): AdapterPreparation {
    if (!isNativeFixtureHandle(prepared.handle)) {
      throw new AgenticHarnessError(
        "native_fixture_handle_invalid",
        "Prepared index handle is not a GNO native fixture index"
      );
    }
    if (
      prepared.corpusFingerprint !== this.snapshot?.fingerprint ||
      prepared.handle.native.corpusFingerprint !== this.snapshot.fingerprint ||
      prepared.indexFingerprint !== prepared.handle.native.indexFingerprint
    ) {
      throw new AgenticHarnessError(
        "native_fixture_handle_mismatch",
        "Prepared native fixture index does not match the corpus snapshot"
      );
    }
    this.handle = prepared.handle;
    this.ownsPreparation = false;
    return this.toPreparation(prepared.preparation);
  }

  private toPreparation(preparation: TimingObservation): AdapterPreparation {
    if (!this.handle || !this.snapshot) {
      throw new AgenticHarnessError(
        "native_fixture_not_prepared",
        "Native fixture preparation is incomplete"
      );
    }
    const native = this.handle.native;
    return {
      adapterId: this.adapterId,
      corpusFingerprint: this.snapshot.fingerprint,
      indexFingerprint: native.indexFingerprint,
      preparation,
      observations: {
        nativeFormat: HANDLE_KIND,
        documentCount: native.documentCount,
        collectionCount: native.collectionCount,
        filesProcessed: native.observations.filesProcessed,
        filesErrored: native.observations.filesErrored,
      },
      tempPaths: [native.rootPath, native.dbPath],
      handle: this.handle,
    };
  }
}

export { mustStore as mustNativeStore };
