/**
 * The REST write paths hand back a 202 and a job id, so the job is where this
 * write is claimed to have succeeded.
 *
 * `syncCollection` returning without an error is not that proof: a path the
 * walker cannot reach, or one the collection excludes, is `skipped` - an
 * ordinary non-error. A job reporting `completed` for a file that is not in the
 * index would move the silent success one step downstream, not remove it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises has no Bun equivalent for directory creation.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";
import type { ContextHolder } from "../../src/serve/routes/api";

import { listDocuments } from "../../src/sdk/documents";
import { getJobStatus } from "../../src/serve/jobs";
import {
  handleCreateCapture,
  handleCreateDoc,
  handleDocs,
} from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

/** A sync that reports a clean pass and indexes nothing - the `skipped` case. */
const indexNothing = async (): Promise<CollectionSyncResult> => ({
  collection: "notes",
  filesProcessed: 1,
  filesAdded: 0,
  filesUpdated: 0,
  filesUnchanged: 0,
  filesErrored: 0,
  filesSkipped: 1,
  filesMarkedInactive: 0,
  durationMs: 1,
  errors: [],
});

const settledJob = async (jobId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = getJobStatus(jobId);
    if (status && status.status !== "running") return status;
    await Bun.sleep(10);
  }
  throw new Error("Job never settled");
};

describe("REST write jobs demand an indexed document", () => {
  let root: string;
  let store: SqliteAdapter;
  let ctxHolder: ContextHolder;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-capture-proof-"));
    await mkdir(join(root, "notes"), { recursive: true });
    store = new SqliteAdapter();
    const opened = await store.open(join(root, "index.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "notes",
          path: join(root, "notes"),
          pattern: "**/*.md",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    };
    ctxHolder = {
      current: { config } as ContextHolder["current"],
      config,
      scheduler: null,
      eventBus: null,
      watchService: null,
    } as ContextHolder;
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("a capture whose file never gets indexed fails its sync job", async () => {
    // DISCRIMINATING: at ede2ed1a this job reported `completed`, so a client
    // polling /api/jobs/:id was told the capture had succeeded.
    const res = await handleCreateCapture(
      ctxHolder,
      store,
      new Request("http://localhost/api/capture", {
        method: "POST",
        body: JSON.stringify({
          collection: "notes",
          title: "Unindexed capture",
          content: "# Unindexed capture\n",
          relPath: "captures/ghost.md",
        }),
      }),
      { syncCollection: indexNothing }
    );

    expect(res.status).toBe(202);
    const receipt = (await res.json()) as { sync: { jobId: string } };
    const job = await settledJob(receipt.sync.jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("not indexed");
    // The file itself is on disk; only the success claim is withheld.
    expect(
      await Bun.file(join(root, "notes", "captures", "ghost.md")).exists()
    ).toBe(true);
  });

  test("a created note that never gets indexed fails its sync job", async () => {
    // DISCRIMINATING: at ede2ed1a this job reported `completed` for a `gno://`
    // URI that resolves to nothing.
    const res = await handleCreateDoc(
      ctxHolder,
      store,
      new Request("http://localhost/api/docs", {
        method: "POST",
        body: JSON.stringify({
          collection: "notes",
          relPath: "created/ghost.md",
          title: "Unindexed note",
          content: "# Unindexed note\n",
        }),
      }),
      { syncCollection: indexNothing }
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    const job = await settledJob(body.jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toContain("not indexed");
  });
});

/**
 * The 202 body is sent BEFORE the write is proven, so `uri` in it is a promise
 * about a path, not a fetchable handle. For a record container that promise is
 * false - the container is indexed as N logical records at virtual paths and
 * `getDocumentByUri` is an exact lookup - and the completed JOB is the only
 * channel that still reaches the same caller.
 */
describe("REST create hands back a resolvable handle for a container", () => {
  let root: string;
  let store: SqliteAdapter;
  let ctxHolder: ContextHolder;
  let events: Array<Record<string, unknown>>;

  const RECORDS = `${[
    { id: "one", title: "First", text: "Zephyr ships Friday" },
    { id: "two", title: "Second", text: "Budget capped at forty" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;

  const create = async (relPath: string, content: string) => {
    const res = await handleCreateDoc(
      ctxHolder,
      store,
      new Request("http://localhost/api/docs", {
        method: "POST",
        body: JSON.stringify({ collection: "records", relPath, content }),
      })
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; uri: string };
    return { body, job: await settledJob(body.jobId) };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-create-handle-"));
    await mkdir(join(root, "records"), { recursive: true });
    store = new SqliteAdapter();
    const opened = await store.open(join(root, "index.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "records",
          path: join(root, "records"),
          pattern: "**/*",
          include: [],
          exclude: [],
          recordAdapters: {
            jsonl: {
              fieldMapping: { id: "/id", title: "/title", body: "/text" },
            },
          },
        },
      ],
      contexts: [],
    };
    const registered = await store.syncCollections(config.collections);
    if (!registered.ok) throw new Error(registered.error.message);
    events = [];
    ctxHolder = {
      current: { config } as ContextHolder["current"],
      config,
      scheduler: null,
      eventBus: {
        emit: (event: Record<string, unknown>) => {
          events.push(event);
        },
      },
      watchService: null,
    } as unknown as ContextHolder;
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("the completed job names the records, not the unfetchable file URI", async () => {
    const { body, job } = await create("export.jsonl", RECORDS);

    expect(job.status).toBe("completed");
    // DISCRIMINATING against 5e5ed7ca: the job result was a bare `SyncResult`
    // with no handle at all, so a client polling a COMPLETED job still had
    // nothing but the 202's `gno://records/export.jsonl` - a URI that resolves
    // to no document.
    const written = job.result?.written;
    expect(written?.kind).toBe("record-container");
    expect(written).not.toHaveProperty("uri");
    const recordUris =
      written?.kind === "record-container" ? written.recordUris : [];
    expect(recordUris).toHaveLength(2);
    expect(recordUris).not.toContain(body.uri);
    // "Fetchable" is asserted against the store, not against the string shape.
    for (const uri of recordUris) {
      const row = await store.getDocumentByUri(uri);
      expect(row.ok && row.value !== null).toBe(true);
    }
    const container = await store.getDocumentByUri(body.uri);
    expect(container.ok && container.value).toBeNull();

    // The emitted event carried the same false promise and now carries the
    // same correction.
    const emitted = events.find((event) => event.type === "document-changed");
    expect(emitted?.kind).toBe("record-container");
    expect(emitted?.recordUris).toEqual(recordUris);
    expect(emitted?.uri).toBe(body.uri);
  });

  test("the handle and the event carry bounded metadata, not the container", async () => {
    // DISCRIMINATING against fbbfdcaa: neither the job handle nor the event
    // frame carried a count or a truncation marker at all - `recordUris` WAS
    // the container, one entry per record, retained on the job for an hour and
    // re-encoded into the frame for every connected client.
    const { job } = await create("bounded.jsonl", RECORDS);
    const written = job.result?.written;

    expect(written?.kind === "record-container" && written.recordCount).toBe(2);
    expect(
      written?.kind === "record-container" && written.recordUrisTruncated
    ).toBe(0);

    const emitted = events.find(
      (event) =>
        event.type === "document-changed" && event.relPath === "bounded.jsonl"
    );
    expect(emitted?.recordCount).toBe(2);
    expect(emitted?.recordUrisTruncated).toBe(0);
    expect(emitted?.recordUris).toHaveLength(2);
  });

  test("a clean container import says only that it is a container", async () => {
    const { job } = await create("clean.jsonl", RECORDS);

    // REST writes the caller's bytes verbatim, so this import really is fully
    // successful - and a fully successful import must not gain a word.
    //
    // DISCRIMINATING against 386aa65d for the CLAUSE: the handle inherited the
    // capture receipt's "so this receipt carries no docid", which is not true
    // of a `written` handle - it is not a receipt and its type has no docid
    // field. It now ends with the consequence it does have.
    expect(job.result?.written?.reason).toBe(
      "Written as a record container: imported as 2 logical record documents at virtual paths; the container path itself has no document, so there is no single fetchable URI for it - fetch the records in recordUris instead."
    );
  });

  test("a rejected record is disclosed on the completed job", async () => {
    const { job } = await create(
      "partial.jsonl",
      `${RECORDS}{ this line is not JSON\n`
    );

    expect(job.status).toBe("completed");
    // DISCRIMINATING against 5e5ed7ca: `filesAdded: 1` and a `completed` job
    // were the whole story - the thrown-away line was reachable only by
    // digging into `collections[0].files[0].recordImport.failures`.
    expect(job.result?.written?.reason).toContain("Record import was partial");
    expect(job.result?.written?.reason).toContain(
      "1 record rejected by the adapter/jsonl adapter and NOT indexed (2 accepted)"
    );
    // DISCRIMINATING against 386aa65d for the POINTER: it said "the sync
    // result's recordImport.failures" without naming a shape, and the caller
    // holding only the 202 body had no such object. This handle is different
    // from every other surface precisely BECAUSE it rides inside the job's
    // SyncResult - so the pointer names that path, and the path resolves.
    expect(job.result?.written?.reason).toContain(
      "collections[].files[].recordImport.failures"
    );
    const failures =
      job.result?.collections?.[0]?.files?.find(
        (file) => file.relPath === "partial.jsonl"
      )?.recordImport?.failures ?? [];
    expect(failures.length).toBeGreaterThan(0);
  });

  test("an ordinary document still hands back its fetchable URI", async () => {
    const { body, job } = await create("plain.md", "# Plain\n\nBody.\n");

    expect(job.status).toBe("completed");
    const written = job.result?.written;
    expect(written?.kind).toBe("document");
    expect(written?.kind === "document" ? written.uri : "").toBe(body.uri);
    // Unchanged for the ordinary case: nothing unusual to say.
    expect(written?.reason).toBeUndefined();
    const emitted = events.find((event) => event.type === "document-changed");
    expect(emitted?.kind).toBe("document");
    expect(emitted?.recordUris).toBeUndefined();
  });
});

/**
 * `GET /api/docs` has no per-container filter. It never did on this branch
 * except for the two commits that added one and then removed it again.
 *
 * The removal left `recordSourcePath` UNRECOGNISED, which is the failure mode
 * this suite exists to forbid: an unrecognised query parameter is dropped, and
 * a dropped filter is not "no filter I asked for" but "every document there
 * is". A caller written against the documented container contract would read
 * an unrelated collection's documents as one container's records. A parameter
 * this endpoint cannot honour is rejected, exactly as an unusable value of a
 * parameter it does honour already is.
 */
describe("GET /api/docs rejects the unsupported per-container filter", () => {
  let root: string;
  let store: SqliteAdapter;
  let ctxHolder: ContextHolder;

  const RECORDS = `${[
    { id: "one", title: "First", text: "Zephyr ships Friday" },
    { id: "two", title: "Second", text: "Budget capped at forty" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;

  const create = async (
    collection: string,
    relPath: string,
    content: string
  ) => {
    const res = await handleCreateDoc(
      ctxHolder,
      store,
      new Request("http://localhost/api/docs", {
        method: "POST",
        body: JSON.stringify({ collection, relPath, content }),
      })
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    return settledJob(body.jobId);
  };

  const listing = async (query: string) => {
    const res = await handleDocs(
      store,
      new URL(`http://localhost/api/docs${query}`)
    );
    const body = (await res.json()) as {
      documents?: Array<{ uri: string }>;
      error?: { code: string; message: string };
    };
    return { status: res.status, body };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-docs-record-filter-"));
    await mkdir(join(root, "records"), { recursive: true });
    await mkdir(join(root, "notes"), { recursive: true });
    store = new SqliteAdapter();
    const opened = await store.open(join(root, "index.sqlite"), "unicode61");
    if (!opened.ok) throw new Error(opened.error.message);
    const config: Config = {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [
        {
          name: "records",
          path: join(root, "records"),
          pattern: "**/*",
          include: [],
          exclude: [],
          recordAdapters: {
            jsonl: {
              fieldMapping: { id: "/id", title: "/title", body: "/text" },
            },
          },
        },
        {
          name: "notes",
          path: join(root, "notes"),
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ],
      contexts: [],
    };
    const registered = await store.syncCollections(config.collections);
    if (!registered.ok) throw new Error(registered.error.message);
    ctxHolder = {
      current: { config } as ContextHolder["current"],
      config,
      scheduler: null,
      eventBus: { emit: () => undefined },
      watchService: null,
    } as unknown as ContextHolder;

    await create("records", "wanted.jsonl", RECORDS);
    await create("records", "other.jsonl", RECORDS);
    await create("notes", "unrelated.md", "# Unrelated\n\nNot a record.\n");
  });

  afterEach(async () => {
    await store.close();
    await safeRm(root);
  });

  test("rejects recordSourcePath alongside a collection", async () => {
    // DISCRIMINATING against bc44b4c6: the parameter was unrecognised there,
    // so this call answered 200 with the WHOLE `records` collection - both
    // containers' records - presented as the response to a request for
    // `wanted.jsonl`. The counterfactual is asserted directly below.
    const rejected = await listing(
      "?collection=records&recordSourcePath=wanted.jsonl"
    );

    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe("VALIDATION");
    expect(rejected.body.error?.message).toContain("recordSourcePath");
    expect(rejected.body.error?.message).toContain("not a supported parameter");
    // A rejection, not a listing: no documents ride along with the 400.
    expect(rejected.body.documents).toBeUndefined();

    // The counterfactual the rejection prevents: dropping the parameter is not
    // a narrower answer, it is the entire collection.
    const dropped = await listing("?collection=records");
    expect(dropped.status).toBe(200);
    const relPaths = new Set(
      (dropped.body.documents ?? []).map(
        (doc) => (doc as unknown as { relPath: string }).relPath
      )
    );
    expect(relPaths.has("wanted.jsonl")).toBe(true);
    expect(relPaths.has("other.jsonl")).toBe(true);
  });

  test("rejects recordSourcePath with no collection at all", async () => {
    // The worse half of the same bug: with no `collection` the dropped filter
    // widens ACROSS collections, so a caller asking for one container's
    // records would have been handed an unrelated collection's documents.
    const rejected = await listing("?recordSourcePath=wanted.jsonl");

    expect(rejected.status).toBe(400);
    expect(rejected.body.error?.code).toBe("VALIDATION");
    expect(rejected.body.documents).toBeUndefined();

    // DISCRIMINATING against bc44b4c6: that is what the same call returned -
    // documents from a collection the caller never named.
    const dropped = await listing("");
    expect(dropped.status).toBe(200);
    const collections = new Set(
      (dropped.body.documents ?? []).map(
        (doc) => (doc as unknown as { collection: string }).collection
      )
    );
    expect(collections.has("records")).toBe(true);
    expect(collections.has("notes")).toBe(true);
  });

  test("rejects an empty or whitespace recordSourcePath on presence", async () => {
    // Presence, not truthiness: `?recordSourcePath=` is still a caller asking
    // for a filter this endpoint has none of. Falling through on an empty
    // value is the same silent widening by another route.
    for (const query of [
      "?collection=records&recordSourcePath=",
      "?collection=records&recordSourcePath=%20",
      "?recordSourcePath=",
    ]) {
      const rejected = await listing(query);
      expect(rejected.status).toBe(400);
      expect(rejected.body.error?.code).toBe("VALIDATION");
      expect(rejected.body.documents).toBeUndefined();
    }
  });

  test("leaves every supported parameter working", async () => {
    // The rejection is scoped to the one unsupported name: it must not turn
    // into a general refusal of unusual-looking queries.
    const ok = await listing(
      "?collection=records&limit=5&offset=0&sortField=modified&sortOrder=asc"
    );
    expect(ok.status).toBe(200);
    expect((ok.body.documents ?? []).length).toBeGreaterThan(0);
  });

  test("the two mechanisms the handle names actually reach one container", async () => {
    // NOT discriminating against bc44b4c6's CODE - both mechanisms predate
    // this branch. It is discriminating against bc44b4c6's CLAIM, which said
    // the omitted records "are not enumerable" and that no API lists them.
    // The corrected wording names these two, so they are asserted rather than
    // asserted about: an accurate claim has to stay accurate.
    const container = "wanted.jsonl";

    // 1. Prefix-scoped listing. Every record URI shares the container's
    //    virtual record directory, so a scope taken from any URI in the page
    //    enumerates exactly this container - and not the sibling container.
    const all = await store.listDocuments("records");
    if (!all.ok) throw new Error(all.error.message);
    const wantedUris = all.value
      .filter((doc) => doc.active && doc.recordSourcePath === container)
      .map((doc) => doc.uri);
    expect(wantedUris).toHaveLength(2);

    const sample = wantedUris[0] ?? "";
    const scope = sample.slice(0, sample.lastIndexOf("/") + 1);
    expect(scope).toStartWith("gno://records/.gno/records/");
    const scoped = await listDocuments(store, { scope, limit: 100 });
    expect(scoped.documents.map((doc) => doc.uri).sort()).toEqual(
      [...wantedUris].sort()
    );

    // 2. Ordinary collection paging, with `relPath` projected from the
    //    container's own path - which is what makes client-side selection of
    //    one container's records possible without a dedicated endpoint.
    const paged = await listing("?collection=records&limit=100");
    expect(paged.status).toBe(200);
    const selected = (paged.body.documents ?? []).filter(
      (doc) => (doc as unknown as { relPath: string }).relPath === container
    );
    expect(selected.map((doc) => doc.uri).sort()).toEqual(
      [...wantedUris].sort()
    );
  });
});
