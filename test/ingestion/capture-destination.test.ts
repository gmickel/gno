/**
 * Destination safety for paths GNO itself writes into a collection.
 *
 * `mkdir(dir, { recursive: true })` FOLLOWS an existing directory symlink, so
 * every capture/create site that used it wrote first and asked the index
 * second. These pin the pre-write refusal and the post-write proof.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { ActiveCaptureProof } from "../../src/ingestion/capture-destination";
import type { FileSyncResult } from "../../src/ingestion/types";
import type { DocumentRow, StorePort } from "../../src/store/types";

import {
  CaptureDestinationError,
  captureProofDocid,
  captureProofOpenedExistingSyncReason,
  captureProofSyncReason,
  captureSyncReason,
  captureWrittenHandle,
  prepareCaptureDestination,
  requireActiveCaptureDocument,
} from "../../src/ingestion/capture-destination";
import { SyncService } from "../../src/ingestion/sync";
import { MAX_WRITTEN_RECORD_URIS } from "../../src/ingestion/types";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const documentStub = (active: boolean): DocumentRow =>
  ({
    id: 1,
    collection: "notes",
    relPath: "note.md",
    docid: "doc-1",
    uri: "gno://notes/note.md",
    active,
  }) as unknown as DocumentRow;

const storeStub = (
  value: DocumentRow | null,
  failure?: string
): Pick<StorePort, "getDocument"> => ({
  getDocument: async () =>
    failure
      ? { ok: false, error: { code: "QUERY_FAILED", message: failure } }
      : { ok: true, value },
});

/** Direct row present, record half answered by an explicit outcome. */
const storeStubWithRecords = (
  value: DocumentRow | null,
  records: { rows: DocumentRow[] } | { failure: string }
): Pick<StorePort, "getDocument" | "listRecordDocuments"> => ({
  getDocument: async () => ({ ok: true, value }),
  listRecordDocuments: async () =>
    "failure" in records
      ? { ok: false, error: { code: "QUERY_FAILED", message: records.failure } }
      : { ok: true, value: records.rows },
});

describe("prepareCaptureDestination", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-capture-dest-"));
    outside = await mkdtemp(join(tmpdir(), "gno-capture-out-"));
  });

  afterEach(async () => {
    await safeRm(root);
    await safeRm(outside);
  });

  test("creates a real nested parent chain and returns the destination", async () => {
    const absPath = await prepareCaptureDestination(root, "a/b/note.md");

    expect(absPath).toBe(join(root, "a", "b", "note.md"));
    expect((await lstat(join(root, "a", "b"))).isDirectory()).toBe(true);
    await writeFile(absPath, "body");
    expect(await Bun.file(absPath).text()).toBe("body");
  });

  test("accepts an already-real parent chain unchanged", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "note.md"), "old");

    const absPath = await prepareCaptureDestination(root, "a/b/note.md");

    expect(absPath).toBe(join(root, "a", "b", "note.md"));
    expect(await Bun.file(absPath).text()).toBe("old");
  });

  test("refuses a parent symlink that stays inside the collection", async () => {
    await mkdir(join(root, "real"), { recursive: true });
    await symlink(join(root, "real"), join(root, "alias"));

    const error = (await prepareCaptureDestination(root, "alias/note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error).toBeInstanceOf(CaptureDestinationError);
    expect(error?.code).toBe("PATH_NOT_WALKABLE");
    // Nothing may be written, here or through the alias.
    expect(await Bun.file(join(root, "real", "note.md")).exists()).toBe(false);
  });

  test("refuses a parent symlink escaping the collection as containment", async () => {
    await symlink(outside, join(root, "escape"));

    const error = (await prepareCaptureDestination(root, "escape/note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error).toBeInstanceOf(CaptureDestinationError);
    expect(error?.code).toBe("PATH_OUTSIDE_COLLECTION");
    expect(await Bun.file(join(outside, "note.md")).exists()).toBe(false);
  });

  test("refuses a DANGLING escaping parent symlink as containment", async () => {
    await symlink(join(outside, "missing"), join(root, "escape"));

    const error = (await prepareCaptureDestination(root, "escape/note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_OUTSIDE_COLLECTION");
  });

  test("classifies a DANGLING alias inside a SYMLINKED collection root as unwalkable", async () => {
    // The root is legitimately reached through a symlink (`/tmp -> /private/tmp`
    // is the everyday case). Containment is judged against the CANONICAL root,
    // so a lexical dangling target - which still carries the link path - looks
    // like an escape when it is nothing of the sort.
    const realRoot = join(root, "real-root");
    const linkedRoot = join(root, "linked-root");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, linkedRoot);
    await symlink(join(linkedRoot, "missing"), join(linkedRoot, "alias"));

    const error = (await prepareCaptureDestination(
      linkedRoot,
      "alias/note.md"
    ).then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_NOT_WALKABLE");
  });

  test("classifies a DANGLING alias under a symlinked ancestor as containment", async () => {
    // `root/hop -> outside/real` exists, so `root/hop/missing` is lexically
    // inside the collection and canonically outside it, and the collection
    // path here is the CANONICAL root so nothing else can explain the verdict.
    // Only canonical resolution is the truth about where a write would land.
    const canonicalRoot = await realpath(root);
    await mkdir(join(outside, "real"), { recursive: true });
    await symlink(join(outside, "real"), join(canonicalRoot, "hop"));
    await symlink(
      join(canonicalRoot, "hop", "missing"),
      join(canonicalRoot, "alias")
    );

    const error = (await prepareCaptureDestination(
      canonicalRoot,
      "alias/note.md"
    ).then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_OUTSIDE_COLLECTION");
  });

  test("refuses an alias whose target cannot be resolved at all", async () => {
    // `ENOTDIR`, not `ENOENT`: the target's ancestor is a regular file, so the
    // destination is unknowable rather than merely absent. Guessing lexically
    // here is what let a real escape read as "just not indexable".
    await writeFile(join(root, "file.txt"), "body");
    await symlink(join(root, "file.txt", "under-a-file"), join(root, "alias"));

    const error = (await prepareCaptureDestination(root, "alias/note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_UNRESOLVED");
  });

  test("refuses a symlinked leaf name", async () => {
    await writeFile(join(root, "real.md"), "body");
    await symlink(join(root, "real.md"), join(root, "alias.md"));

    const error = (await prepareCaptureDestination(root, "alias.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_NOT_WALKABLE");
    expect(await Bun.file(join(root, "real.md")).text()).toBe("body");
  });

  test("refuses a lexically escaping relative path", async () => {
    const error = (await prepareCaptureDestination(root, "../note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("PATH_OUTSIDE_COLLECTION");
  });

  test("refuses a parent component that exists but is not a directory", async () => {
    await writeFile(join(root, "a"), "not a directory");

    const error = (await prepareCaptureDestination(root, "a/note.md").then(
      () => null,
      (cause: unknown) => cause
    )) as CaptureDestinationError | null;

    expect(error?.code).toBe("NOT_DIRECTORY");
  });
});

describe("requireActiveCaptureDocument", () => {
  test("accepts an active document", async () => {
    const result = await requireActiveCaptureDocument(
      storeStub(documentStub(true)),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(true);
  });

  test("refuses a missing document - the case a skipped sync leaves behind", async () => {
    const result = await requireActiveCaptureDocument(
      storeStub(null),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("not indexed");
  });

  test("refuses an inactive document", async () => {
    const result = await requireActiveCaptureDocument(
      storeStub(documentStub(false)),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("inactive");
  });

  test("refuses when the store lookup itself fails", async () => {
    const result = await requireActiveCaptureDocument(
      storeStub(null, "db gone"),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe("db gone");
  });

  /**
   * DISCRIMINATING against 179e062b: there, a failed `listRecordDocuments` was
   * propagated ONLY when the direct row was null, so an inactive direct row
   * plus a failed record query reported "the document is inactive" - a
   * confident claim the store could not support, with the failure concealed.
   */
  test("a record-query failure is reported as such, not as an inactive document", async () => {
    const result = await requireActiveCaptureDocument(
      storeStubWithRecords(documentStub(false), { failure: "index locked" }),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe("index locked");
    expect(result.ok === false && result.message).not.toContain("inactive");
  });

  /**
   * The opened-existing callers need the two failures apart: a store that could
   * not answer still has to surface as an error, not as the far calmer "this
   * file is not indexed yet".
   */
  test("separates a store failure from an honest not-indexed answer", async () => {
    const storeFailure = await requireActiveCaptureDocument(
      storeStub(null, "db gone"),
      "notes",
      "note.md"
    );
    const missing = await requireActiveCaptureDocument(
      storeStub(null),
      "notes",
      "note.md"
    );
    const inactive = await requireActiveCaptureDocument(
      storeStub(documentStub(false)),
      "notes",
      "note.md"
    );
    const recordFailure = await requireActiveCaptureDocument(
      storeStubWithRecords(documentStub(false), { failure: "index locked" }),
      "notes",
      "note.md"
    );

    expect(storeFailure.ok === false && storeFailure.failure).toBe(
      "store-error"
    );
    expect(recordFailure.ok === false && recordFailure.failure).toBe(
      "store-error"
    );
    expect(missing.ok === false && missing.failure).toBe("not-indexed");
    expect(inactive.ok === false && inactive.failure).toBe("not-indexed");
  });

  /** The failure fix must not turn an honest "inactive" into "unknown". */
  test("an inactive document with a successful, empty record query is still inactive", async () => {
    const result = await requireActiveCaptureDocument(
      storeStubWithRecords(documentStub(false), { rows: [] }),
      "notes",
      "note.md"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("inactive");
  });
});

/**
 * The proof is by EFFECTIVE SOURCE PATH, not by `rel_path`.
 *
 * A capture whose destination is a configured record-container format is
 * imported as LOGICAL documents under virtual `#record/...` rel paths, with the
 * written file in `record_source_path`. A `rel_path`-only proof calls that
 * successful import "not indexed" and the receipt reports FAILURE - so these
 * run against a real store and a real sync, not a stub.
 */
describe("requireActiveCaptureDocument - record containers", () => {
  let root: string;
  let store: SqliteAdapter;
  let collection: Config["collections"][number];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-capture-records-"));
    store = new SqliteAdapter();
    expect((await store.open(join(root, "index.db"), "unicode61")).ok).toBe(
      true
    );
    collection = {
      name: "captures",
      path: root,
      pattern: "**/*",
      include: [],
      exclude: [],
      recordAdapters: {
        jsonl: {
          fieldMapping: {
            id: "/id",
            title: "/title",
            body: "/text",
            dateFields: { created: "/created" },
          },
        },
        transcript: { format: "vtt" },
      },
    };
    expect((await store.syncCollections([collection])).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  const syncCollection = async () => {
    const result = await new SyncService().syncCollection(collection, store, {
      projectTypedEdges: false,
    });
    expect(result.filesErrored).toBe(0);
    return result;
  };

  test("a captured .jsonl record container satisfies the proof", async () => {
    const relPath = "export.jsonl";
    await Bun.write(
      join(root, relPath),
      `${[
        {
          id: "launch",
          title: "Launch decision",
          text: "Project Zephyr launches Friday",
          created: "2026-07-22T09:00:00Z",
        },
        {
          id: "budget",
          title: "Budget decision",
          text: "Budget remains capped at forty units",
          created: "2026-07-22T10:00:00Z",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`
    );
    await syncCollection();

    // The container itself has no `rel_path` document - only logical records.
    const direct = await store.getDocument("captures", relPath);
    expect(direct.ok && direct.value).toBeNull();

    const result = await requireActiveCaptureDocument(
      store,
      "captures",
      relPath
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe("record-container");
    const proven =
      result.ok && result.kind === "record-container" ? result.records : [];
    // Multiple logical records from one written file is the normal case.
    expect(proven).toHaveLength(2);
    expect(proven.every((row) => row.recordSourcePath === relPath)).toBe(true);
    expect(proven.every((row) => row.active)).toBe(true);

    // DISCRIMINATING against 179e062b: there the proof collapsed the container
    // into its FIRST active record and handed that row back as `document`, so
    // callers paired that record's docid with a receipt URI built from the
    // PHYSICAL path - two different things. The container proof now offers no
    // single docid at all, and every record's own URI is a virtual record path
    // that the physical URI never equals.
    const proof = result.ok ? result : null;
    expect(proof && captureProofDocid(proof)).toBeUndefined();
    expect(proof && captureProofSyncReason(proof)).toContain(
      "2 logical record documents"
    );
    // The opened-existing surfaces state the SAME fact; only the tense differs,
    // because nothing was written just now.
    expect(proof && captureProofOpenedExistingSyncReason(proof)).toContain(
      "Existing file is a record container"
    );
    expect(proof && captureProofOpenedExistingSyncReason(proof)).toContain(
      "2 logical record documents"
    );
    const physicalUri = `gno://captures/${relPath}`;
    expect(proven.some((row) => row.uri === physicalUri)).toBe(false);
    expect(proven.every((row) => row.relPath.startsWith(".gno/records/"))).toBe(
      true
    );
  });

  test("a captured .vtt transcript container satisfies the proof", async () => {
    const relPath = "meeting.vtt";
    await Bun.write(
      join(root, relPath),
      Bun.file(
        join(import.meta.dir, "../fixtures/exports/transcript/sample.vtt")
      )
    );
    await syncCollection();

    const direct = await store.getDocument("captures", relPath);
    expect(direct.ok && direct.value).toBeNull();

    const result = await requireActiveCaptureDocument(
      store,
      "captures",
      relPath
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe("record-container");
    const proven =
      result.ok && result.kind === "record-container" ? result.records : [];
    expect(proven.length).toBeGreaterThan(0);
    expect(proven.every((row) => row.recordSourcePath === relPath)).toBe(true);
    expect(proven.every((row) => row.active)).toBe(true);
  });

  test("an ordinary markdown capture still satisfies the proof by rel_path", async () => {
    const relPath = "note.md";
    await Bun.write(join(root, relPath), "# Note\n\nordinary capture body\n");
    await syncCollection();

    const result = await requireActiveCaptureDocument(
      store,
      "captures",
      relPath
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.kind).toBe("file");
    const document =
      result.ok && result.kind === "file" ? result.document : null;
    expect(document?.relPath).toBe(relPath);
    expect(document?.recordSourcePath).toBeFalsy();
    // A plain file IS its document: docid and URI describe the same path, so
    // the receipt may carry both.
    const proof = result.ok ? result : null;
    expect(proof && captureProofDocid(proof)).toBe(document?.docid ?? "");
    expect(proof && captureProofSyncReason(proof)).toBeUndefined();
    expect(
      proof && captureProofOpenedExistingSyncReason(proof)
    ).toBeUndefined();
  });

  test("an unindexed write still FAILS the proof - the fallback is not a rubber stamp", async () => {
    await syncCollection();
    // Written after the sync: on disk, in no index.
    await Bun.write(join(root, "unindexed.jsonl"), '{"id":"a","text":"b"}\n');

    const result = await requireActiveCaptureDocument(
      store,
      "captures",
      "unindexed.jsonl"
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("not indexed");
  });

  test("a deactivated record container FAILS the proof", async () => {
    const relPath = "export.jsonl";
    await Bun.write(
      join(root, relPath),
      '{"id":"one","title":"One","text":"first body"}\n'
    );
    await syncCollection();
    expect(
      (await requireActiveCaptureDocument(store, "captures", relPath)).ok
    ).toBe(true);

    // An authoritative empty snapshot deactivates every logical record.
    await Bun.write(join(root, relPath), "");
    await syncCollection();

    const result = await requireActiveCaptureDocument(
      store,
      "captures",
      relPath
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("not indexed");
  });
});

/**
 * A record container's own file result is a NON-ERROR as long as the adapter
 * accepted at least one record, so "the sync did not fail" says nothing about
 * the records it threw away. Those live in `recordImport`, and every capture
 * surface composes its `sync.reason` from both halves here so none of them can
 * report a half-imported file as a clean one.
 */
describe("captureSyncReason - container shape and import completeness", () => {
  const containerProof: ActiveCaptureProof = {
    ok: true,
    kind: "record-container",
    records: [documentStub(true), documentStub(true)],
  };

  const fileProof: ActiveCaptureProof = {
    ok: true,
    kind: "file",
    document: documentStub(true),
  };

  const recordImport = (overrides: {
    accepted: number;
    failed: number;
    snapshotState: "complete" | "partial";
  }): NonNullable<FileSyncResult["recordImport"]> => ({
    adapterId: "adapter/jsonl",
    adapterVersion: "1.0.0",
    adapterFingerprint: "fp",
    snapshotState: overrides.snapshotState,
    authoritative: true,
    stoppedByCap: false,
    sourceBytesRead: 128,
    records: {
      accepted: overrides.accepted,
      added: overrides.accepted,
      updated: 0,
      reactivated: 0,
      unchanged: 0,
      deactivated: 0,
      preserved: 0,
      failed: overrides.failed,
    },
    items: [],
    itemsTruncated: 0,
    warnings: [],
    failures: [],
  });

  const CONTAINER_ONLY =
    "Written as a record container: imported as 2 logical record documents at virtual paths; the container path itself has no document, so this receipt carries no docid.";

  // The same FACT, finished with the consequence a handle actually has.
  const CONTAINER_ONLY_HANDLE =
    "Written as a record container: imported as 2 logical record documents at virtual paths; the container path itself has no document, so there is no single fetchable URI for it - fetch the records in recordUris instead.";

  test("a fully successful import reads exactly as it did before", () => {
    // The whole no-false-alarm requirement: an import with nothing rejected and
    // a complete snapshot must not gain a word.
    expect(
      captureSyncReason(
        containerProof,
        recordImport({ accepted: 2, failed: 0, snapshotState: "complete" })
      )
    ).toBe(CONTAINER_ONLY);
    expect(captureSyncReason(containerProof)).toBe(CONTAINER_ONLY);
    expect(
      captureSyncReason(
        fileProof,
        recordImport({ accepted: 1, failed: 0, snapshotState: "complete" })
      )
    ).toBeUndefined();
  });

  test("a rejected record is stated alongside the container fact", () => {
    // DISCRIMINATING against 5e5ed7ca: the reason was `captureProofSyncReason`
    // alone, which sees only the proof, so this returned CONTAINER_ONLY - the
    // identical string a clean import produces.
    const reason = captureSyncReason(
      containerProof,
      recordImport({ accepted: 2, failed: 1, snapshotState: "partial" })
    );

    expect(reason).toStartWith(CONTAINER_ONLY);
    expect(reason).toContain(
      "1 record rejected by the adapter/jsonl adapter and NOT indexed (2 accepted)"
    );
    expect(reason).toContain("partial snapshot");
  });

  test("a partial snapshot alone is disclosed, with nothing rejected", () => {
    const reason = captureSyncReason(
      containerProof,
      recordImport({ accepted: 2, failed: 0, snapshotState: "partial" })
    );

    expect(reason).toContain("Record import was partial");
    expect(reason).not.toContain("rejected");
    // Records the adapter never saw were kept from the last import, so calling
    // this a full refresh would be the same silent success one layer down.
    expect(reason).toContain("preserved from the previous import");
  });

  test("the written handle offers only URIs a caller can fetch", () => {
    const container = captureWrittenHandle(
      containerProof,
      { collection: "records", relPath: "export.jsonl" },
      recordImport({ accepted: 2, failed: 1, snapshotState: "partial" })
    );
    const document = captureWrittenHandle(fileProof, {
      collection: "notes",
      relPath: "note.md",
    });

    // DISCRIMINATING against 5e5ed7ca: the REST create job had no handle at
    // all and its caller was left with `gno://records/export.jsonl`, which
    // `getDocumentByUri` resolves to nothing. The container shape carries no
    // `uri` field, so that URI cannot be handed back by accident.
    expect(container.kind).toBe("record-container");
    expect(container).not.toHaveProperty("uri");
    expect(
      container.kind === "record-container" ? container.recordUris : []
    ).toEqual(["gno://notes/note.md", "gno://notes/note.md"]);
    expect(container.reason).toContain("rejected");

    expect(document.kind).toBe("document");
    expect(document.kind === "document" ? document.uri : "").toBe(
      "gno://notes/note.md"
    );
    expect(document.reason).toBeUndefined();
  });

  test("the handle states the consequence a handle HAS, not a receipt's", () => {
    // DISCRIMINATING against 386aa65d: there every consumer inherited the
    // receipt's consequence, so this handle - which has no docid field in its
    // type at all - announced that "this receipt carries no docid". A caller
    // reading it went looking for a docid contract that does not exist, and
    // was told nothing about the thing it had actually lost: the single
    // fetchable URI. At 386aa65d this asserted exactly CONTAINER_ONLY.
    const clean = captureWrittenHandle(containerProof, {
      collection: "records",
      relPath: "clean.jsonl",
    });

    expect(clean.reason).toBe(CONTAINER_ONLY_HANDLE);
    expect(clean.reason).not.toContain("docid");
    // The receipt surfaces keep the clause that IS true of them.
    expect(captureSyncReason(containerProof)).toBe(CONTAINER_ONLY);
  });

  test("each surface points at failures its own caller can reach", () => {
    // DISCRIMINATING against 386aa65d: both of these ended "See the sync
    // result's recordImport.failures", and neither caller holds a sync result
    // in the receipt case - the CaptureReceipt has no recordImport field, so
    // the pointer named a dead end. The handle DOES ride inside the job's
    // SyncResult, which is the whole difference.
    const partial = recordImport({
      accepted: 2,
      failed: 1,
      snapshotState: "complete",
    });
    const receipt = captureSyncReason(containerProof, partial);
    const handle = captureWrittenHandle(
      containerProof,
      { collection: "records", relPath: "partial.jsonl" },
      partial
    );

    expect(receipt).toContain(
      "This response does not carry the per-record failures"
    );
    expect(receipt).toContain("gno update --verbose");
    expect(receipt).not.toContain("recordImport.failures");

    expect(handle.reason).toContain(
      "collections[].files[].recordImport.failures"
    );
    expect(handle.reason).not.toContain("does not carry");
  });

  test("a partial snapshot alone points nowhere, having no per-record list", () => {
    // NON-DISCRIMINATING against 386aa65d, and deliberately so: the pointer
    // was already gated on `failed > 0` there and must stay gated now that
    // there are two of them. A snapshot the adapter could not complete names
    // no individual record, so promising a list would be the same defect in
    // the opposite direction.
    const reason = captureSyncReason(
      containerProof,
      recordImport({ accepted: 2, failed: 0, snapshotState: "partial" })
    );

    expect(reason).toContain("preserved from the previous import");
    expect(reason).not.toContain("does not carry the per-record failures");
    expect(reason).not.toContain("recordImport.failures");
  });
});

/**
 * A container is not a small thing, and the handle for one is retained and
 * copied long past the write: the job manager keeps up to 100 completed jobs
 * for an hour, and the `document-changed` frame is JSON-encoded once per
 * connected SSE client. A handle that listed every record URI therefore turned
 * one valid 100k-record export into megabytes of retained strings and a
 * multi-megabyte event frame - while the record IMPORT receipt sitting beside
 * it has been capped at 1,000 items all along.
 *
 * The cap must not cost reachability, which is the whole reason the handle
 * exists: the page is non-empty, `recordCount` is exact, and the reason names
 * the query that reaches the records the page omits.
 */
describe("captureWrittenHandle - the record page is bounded", () => {
  const containerOf = (count: number): ActiveCaptureProof => ({
    ok: true,
    kind: "record-container",
    records: Array.from(
      { length: count },
      (_, index) =>
        ({
          id: index + 1,
          collection: "records",
          relPath: `.gno/records/export.jsonl/${index}`,
          docid: `doc-${index}`,
          uri: `gno://records/.gno/records/export.jsonl/${index}`,
          active: true,
        }) as unknown as DocumentRow
    ),
  });

  const handleFor = (count: number) =>
    captureWrittenHandle(containerOf(count), {
      collection: "records",
      relPath: "export.jsonl",
    });

  test("exactly at the cap the page is complete and says nothing extra", () => {
    // DISCRIMINATING against fbbfdcaa only for `recordCount`/
    // `recordUrisTruncated`, which did not exist: the URI list itself is
    // unchanged at the boundary, which is the point - the cap must not start
    // truncating one record early.
    const handle = handleFor(MAX_WRITTEN_RECORD_URIS);
    if (handle.kind !== "record-container") {
      throw new Error("expected a record-container handle");
    }

    expect(handle.recordUris).toHaveLength(MAX_WRITTEN_RECORD_URIS);
    expect(handle.recordCount).toBe(MAX_WRITTEN_RECORD_URIS);
    expect(handle.recordUrisTruncated).toBe(0);
    expect(handle.reason).not.toContain("recordUris lists the first");
  });

  test("one past the cap pages, keeps the count exact, and says how to get the rest", () => {
    // DISCRIMINATING against fbbfdcaa: `recordUris` there was
    // `proof.records.map(...)`, so this was a 1,001-entry array - and at a
    // realistic container size a six-figure one, in the job result AND in the
    // SSE frame.
    const handle = handleFor(MAX_WRITTEN_RECORD_URIS + 1);
    if (handle.kind !== "record-container") {
      throw new Error("expected a record-container handle");
    }

    expect(handle.recordUris).toHaveLength(MAX_WRITTEN_RECORD_URIS);
    expect(handle.recordCount).toBe(MAX_WRITTEN_RECORD_URIS + 1);
    expect(handle.recordUrisTruncated).toBe(1);
    // Still fetchable handles, still never the container path.
    expect(handle).not.toHaveProperty("uri");
    expect(handle.recordUris[0]).toBe(
      "gno://records/.gno/records/export.jsonl/0"
    );
    expect(handle.recordUris).not.toContain("gno://records/export.jsonl");
    // The bound is stated, and stated accurately in BOTH directions. Not
    // dressed up as a continuation (there is no per-container enumeration
    // endpoint, so no offset is named), and not understated either: the
    // omitted records ARE reachable, so the reason must not claim otherwise
    // and must name where to go.
    expect(handle.reason).toContain(
      `recordUris lists the first ${MAX_WRITTEN_RECORD_URIS} of ${MAX_WRITTEN_RECORD_URIS + 1} records`
    );
    expect(handle.reason).not.toContain("not enumerable");
    expect(handle.reason).toContain("no dedicated per-container enumeration");
    // The two mechanisms that do reach the whole container, named.
    expect(handle.reason).toContain("virtual record URI prefix");
    expect(handle.reason).toContain("relPath");
    // Still no fabricated continuation and no endpoint-specific promise.
    expect(handle.reason).not.toContain("/api/docs");
    expect(handle.reason).not.toContain("offset");
    // The container fact is still stated first, unchanged.
    expect(handle.reason).toStartWith("Written as a record container:");
  });

  test("a huge container costs a bounded handle, not a proportional one", () => {
    // The heap-pressure claim itself: at fbbfdcaa this handle held 100,000 URI
    // strings, retained for an hour and re-encoded per SSE client.
    const handle = handleFor(100_000);
    if (handle.kind !== "record-container") {
      throw new Error("expected a record-container handle");
    }

    expect(handle.recordUris).toHaveLength(MAX_WRITTEN_RECORD_URIS);
    expect(handle.recordCount).toBe(100_000);
    expect(handle.recordUrisTruncated).toBe(99_000);
    expect(JSON.stringify(handle).length).toBeLessThan(100_000);
  });
});
