import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccessHookRequest } from "../../src/core/access-hook";

import { HttpGatewayAccessHookSchema } from "../../src/config/types";
import {
  callAccessHook,
  createAccessHookSession,
  createDocumentAccessCheck,
  parseAccessRef,
  provenanceRefs,
} from "../../src/core/access-hook";
import { safeRm } from "../helpers/cleanup";

let directory: string;
let socket: string;
let server: ReturnType<typeof Bun.serve>;
const seen: AccessHookRequest[] = [];
/** Per-test behaviour of the fake hook, keyed by subject. */
const modes: Record<
  string,
  (body: AccessHookRequest) => Response | Promise<Response>
> = {
  // Allows every ref whose ref part does not start with "deny".
  ok: (body) =>
    Response.json({
      allow: body.refs.flatMap((ref, index) =>
        ref.ref.startsWith("deny") ? [] : [index]
      ),
    }),
  status500: () => new Response("boom", { status: 500 }),
  notJson: () => new Response("{allow", { status: 200 }),
  noAllow: () => Response.json({ allowed: [0] }),
  junk: (body) =>
    Response.json({ allow: [-1, 0.5, "1", 0, body.refs.length, 99] }),
  slow: async () => {
    await Bun.sleep(300);
    return Response.json({ allow: [0] });
  },
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "gno-hook-"));
  socket = join(directory, "hook.sock");
  server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const body = (await request.json()) as AccessHookRequest;
      seen.push(body);
      return modes[body.subject]!(body);
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  await safeRm(directory);
});

const hook = () => ({
  url: "http://hook/check",
  unix: socket,
  timeoutMs: 100,
});
const request = (subject: string, refs: string[]): AccessHookRequest => ({
  subject,
  ctx: "1to1",
  request_id: "req-1",
  refs: refs.map((member) => parseAccessRef(member)!),
});

describe("access hook config", () => {
  test("http(s) url, optional unix socket and bounded timeout", () => {
    const parse = (value: unknown) =>
      HttpGatewayAccessHookSchema.safeParse(value).success;
    expect(parse({ url: "http://hook/check", unix: "/tmp/h.sock" })).toBe(true);
    expect(parse({ url: "https://hook.example/check", timeoutMs: 500 })).toBe(
      true
    );
    expect(parse({ url: "file:///etc/passwd" })).toBe(false);
    expect(parse({ url: "http://hook", timeoutMs: 0 })).toBe(false);
    expect(parse({ url: "http://hook", extra: 1 })).toBe(false);
  });
});

describe("callAccessHook", () => {
  test("posts {subject, ctx, request_id, refs} over the unix socket", async () => {
    seen.length = 0;
    const verdicts = await callAccessHook(
      hook(),
      request("ok", ["sp:drives/a", "sp:deny/b", "web:https://x/y z"])
    );
    expect(verdicts).toEqual([true, false, true]);
    expect(seen).toEqual([
      {
        subject: "ok",
        ctx: "1to1",
        request_id: "req-1",
        refs: [
          { sys: "sp", ref: "drives/a" },
          { sys: "sp", ref: "deny/b" },
          { sys: "web", ref: "https://x/y z" },
        ],
      },
    ]);
  });

  test("error status, malformed body, junk indexes and lateness deny", async () => {
    for (const subject of ["status500", "notJson", "noAllow", "slow"]) {
      expect(
        await callAccessHook(hook(), request(subject, ["sp:a", "sp:b"]))
      ).toEqual([false, false]);
    }
    // Only valid in-range integer indexes count.
    expect(
      await callAccessHook(hook(), request("junk", ["sp:a", "sp:b"]))
    ).toEqual([true, false]);
  });

  test("queue time counts toward the deadline", async () => {
    // One slot, 150 ms answers, 250 ms deadline. The fake ignores abort, so
    // a sent call holds its slot until it answers.
    let sent = 0;
    const slowFetch = async () => {
      sent += 1;
      await Bun.sleep(150);
      return Response.json({ allow: [0] });
    };
    const limited = {
      url: "http://hook/queue-deadline",
      timeoutMs: 250,
      maxConcurrent: 1,
    };
    const started = performance.now();
    const [first, second] = await Promise.all([
      callAccessHook(limited, request("ok", ["sp:a"]), slowFetch),
      callAccessHook(limited, request("ok", ["sp:a"]), slowFetch),
    ]);
    // The second answer would land at about 300 ms, past its deadline.
    expect(first).toEqual([true]);
    expect(second).toEqual([false]);
    expect(performance.now() - started).toBeLessThan(290);

    // A call still queued at its deadline is never sent.
    sent = 0;
    const longFetch = async () => {
      sent += 1;
      await Bun.sleep(400);
      return Response.json({ allow: [0] });
    };
    const queued = { ...limited, url: "http://hook/queue-expiry" };
    const verdicts = await Promise.all([
      callAccessHook(queued, request("ok", ["sp:a"]), longFetch),
      callAccessHook(queued, request("ok", ["sp:a"]), longFetch),
    ]);
    expect(verdicts).toEqual([[false], [false]]);
    expect(sent).toBe(1);
  });

  test("an unreachable hook denies", async () => {
    expect(
      await callAccessHook(
        { ...hook(), unix: join(directory, "missing.sock") },
        request("ok", ["sp:a"])
      )
    ).toEqual([false]);
  });

  test("no refs makes no call", async () => {
    seen.length = 0;
    expect(await callAccessHook(hook(), request("ok", []))).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("provenance refs", () => {
  test("parse <sys>:<ref> members under the collection key", () => {
    expect(provenanceRefs({ derived_from: ["sp:a", "web:b"] }, null)).toEqual([
      { sys: "sp", ref: "a" },
      { sys: "web", ref: "b" },
    ]);
    expect(provenanceRefs({ sources: ["sp:a"] }, null, "sources")).toEqual([
      { sys: "sp", ref: "a" },
    ]);
    expect(provenanceRefs({ sources: ["sp:a"] }, null)).toBeNull();
    expect(provenanceRefs({ derived_from: [] }, null)).toBeNull();
    expect(provenanceRefs({ derived_from: ["sp:a", "bad"] }, null)).toBeNull();
    expect(provenanceRefs({ derived_from: ["sp:a"] }, "broken")).toBeNull();
  });
});

describe("session and document check", () => {
  test("each distinct ref is asked once per request", async () => {
    seen.length = 0;
    const session = createAccessHookSession(hook(), {
      subject: "ok",
      ctx: "shared",
      requestId: "r",
    });
    const refs = [parseAccessRef("sp:a")!, parseAccessRef("sp:deny")!];
    expect([...(await session.allowed(refs))]).toEqual(["sp:a"]);
    expect([...(await session.allowed([...refs, refs[0]!]))]).toEqual(["sp:a"]);
    expect(session.calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ctx).toBe("shared");
  });

  test("a document needs every ref allowed and a readable collection", async () => {
    const check = createDocumentAccessCheck({
      session: createAccessHookSession(hook(), {
        subject: "ok",
        ctx: "1to1",
        requestId: "r",
      }),
      canRead: (name) => name !== "hidden",
      provenanceKeyOf: (name) =>
        name === "keyed" ? "sources" : "derived_from",
    });
    const allowed = await check([
      { id: 1, collection: "c", typedMetadata: { derived_from: ["sp:a"] } },
      {
        id: 2,
        collection: "c",
        typedMetadata: { derived_from: ["sp:a", "sp:deny-x"] },
      },
      {
        id: 3,
        collection: "hidden",
        typedMetadata: { derived_from: ["sp:a"] },
      },
      { id: 4, collection: "c", typedMetadata: { derived_from: ["nope"] } },
      { id: 5, collection: "keyed", typedMetadata: { sources: ["sp:b"] } },
      { id: 6, collection: "keyed", typedMetadata: { derived_from: ["sp:b"] } },
    ]);
    expect([...allowed].toSorted((a, b) => a - b)).toEqual([1, 5]);
  });

  test("a failing hook denies every document", async () => {
    const check = createDocumentAccessCheck({
      session: createAccessHookSession(hook(), {
        subject: "status500",
        ctx: "1to1",
        requestId: "r",
      }),
      canRead: () => true,
      provenanceKeyOf: () => "derived_from",
    });
    expect(
      (
        await check([
          { id: 1, collection: "c", typedMetadata: { derived_from: ["sp:a"] } },
        ])
      ).size
    ).toBe(0);
  });
});
