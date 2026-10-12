import { describe, expect, test } from "bun:test";

import type { Config } from "../../src/config/types";

import {
  CollectionEgressPolicyService,
  collectionEgressPolicyEpoch,
} from "../../src/core/collection-egress-policy-service";
import { EGRESS_MAX_COLLECTIONS } from "../../src/core/egress-limits";

const config = (): Config =>
  ({
    collections: [
      {
        name: "notes",
        path: "/tmp/notes",
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      {
        name: "public",
        path: "/tmp/public",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        egressPolicy: "remote",
      },
    ],
    contexts: [],
  }) as unknown as Config;

describe("collection egress policy management", () => {
  test("requires a one-use relaxation confirmation bound to collection, revision, and target", async () => {
    let current = config();
    const invalidations: string[] = [];
    const service = new CollectionEgressPolicyService({
      getConfig: () => current,
      mutateConfig: async (mutate) => {
        const result = mutate(current);
        if (!result.ok) return result;
        current = result.config;
        return { ok: true, config: current, value: result.value };
      },
      onPolicyChanged: () => {
        const policyEpoch = collectionEgressPolicyEpoch(current);
        invalidations.push(policyEpoch);
        return {
          policyEpoch,
          queuedJobsInvalidated: 2,
          sessionsInvalidated: 1,
          staleWorkMustRetry: true,
        };
      },
    });
    const before = service.get("notes");
    expect(before.ok).toBeTrue();
    if (!before.ok) throw new Error(before.error);
    expect(before.value.effectivePolicy).toBe("local_only");
    expect(before.value.source).toBe("config_default");
    expect(before.value.revision).toBe(0);

    const unconfirmed = await service.set({
      collection: "notes",
      policy: "remote",
    });
    expect(unconfirmed).toMatchObject({
      ok: false,
      code: "EGRESS_RELAXATION_CONFIRMATION_REQUIRED",
    });
    const stale = await service.set({
      collection: "notes",
      policy: "remote",
      confirmation: {
        collection: "public",
        currentPolicy: "local_only",
        currentRevision: 0,
        targetPolicy: "remote",
        acknowledged: true,
      },
    });
    expect(stale.ok).toBeFalse();
    const wrongTarget = await service.set({
      collection: "notes",
      policy: "remote",
      confirmation: {
        collection: "notes",
        currentPolicy: "local_only",
        currentRevision: 0,
        targetPolicy: "lan",
        acknowledged: true,
      },
    });
    expect(wrongTarget).toMatchObject({
      ok: false,
      code: "EGRESS_RELAXATION_CONFIRMATION_REQUIRED",
    });

    const changed = await service.set({
      collection: "notes",
      policy: "remote",
      confirmation: {
        collection: "notes",
        currentPolicy: "local_only",
        currentRevision: before.value.revision,
        targetPolicy: "remote",
        acknowledged: true,
      },
    });
    expect(changed).toMatchObject({
      ok: true,
      value: {
        change: "relaxed",
        current: {
          effectivePolicy: "remote",
          revision: 1,
          source: "explicit",
        },
        invalidation: {
          queuedJobsInvalidated: 2,
          sessionsInvalidated: 1,
          staleWorkMustRetry: true,
        },
      },
    });
    expect(invalidations).toHaveLength(1);
    expect(current.collections[0]?.egressPolicy).toBe("remote");
    expect(current.collections[0]?.egressPolicyRevision).toBe(1);

    const tightened = await service.set({
      collection: "notes",
      policy: "local_only",
    });
    expect(tightened).toMatchObject({
      ok: true,
      value: { change: "tightened", current: { revision: 2 } },
    });
    const replayed = await service.set({
      collection: "notes",
      policy: "remote",
      confirmation: {
        collection: "notes",
        currentPolicy: "local_only",
        currentRevision: before.value.revision,
        targetPolicy: "remote",
        acknowledged: true,
      },
    });
    expect(replayed).toMatchObject({
      ok: false,
      code: "EGRESS_RELAXATION_CONFIRMATION_REQUIRED",
    });
  });

  test("allows only one of two concurrent uses of the same relaxation confirmation", async () => {
    let current = config();
    let mutationQueue = Promise.resolve();
    const service = new CollectionEgressPolicyService({
      getConfig: () => current,
      mutateConfig: (mutate) => {
        const mutation = mutationQueue.then(() => {
          const result = mutate(current);
          if (!result.ok) return result;
          current = result.config;
          return { ok: true as const, config: current, value: result.value };
        });
        mutationQueue = mutation.then(() => undefined);
        return mutation;
      },
    });
    const confirmation = {
      collection: "notes",
      currentPolicy: "local_only",
      currentRevision: 0,
      targetPolicy: "remote",
      acknowledged: true,
    } as const;

    const results = await Promise.all([
      service.set({ collection: "notes", policy: "remote", confirmation }),
      service.set({ collection: "notes", policy: "remote", confirmation }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          !result.ok &&
          result.code === "EGRESS_RELAXATION_CONFIRMATION_REQUIRED"
      )
    ).toHaveLength(1);
    expect(current.collections[0]?.egressPolicyRevision).toBe(1);
  });

  test("returns one content-free check/explain contract with partial disclosure", () => {
    const service = new CollectionEgressPolicyService({
      getConfig: config,
    });
    const denied = service.explain({
      collections: ["notes", "public"],
      action: "export",
      destinationZone: "remote",
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "retrieval_trace",
    });
    expect(denied).toMatchObject({
      ok: true,
      value: {
        mode: "denied",
        decision: { allowed: false, reason: "POLICY_LOCAL_ONLY" },
        remediation: { code: "POLICY_LOCAL_ONLY" },
      },
    });
    expect(JSON.stringify(denied)).not.toContain("/tmp/");

    const partial = service.check({
      collections: ["notes", "public"],
      action: "export",
      destinationZone: "remote",
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "retrieval_trace",
      partialResults: "explicit",
    });
    expect(partial).toMatchObject({
      ok: true,
      value: {
        mode: "partial",
        allowedCollections: ["public"],
        omittedCollections: [
          { collection: "notes", reason: "POLICY_LOCAL_ONLY" },
        ],
        disclosure: {
          code: "EGRESS_PARTIAL_RESULT",
          omittedCount: 1,
        },
      },
    });
  });

  test("rejects hostile and malformed service inputs before mutation or invalidation", async () => {
    let mutations = 0;
    let invalidations = 0;
    const service = new CollectionEgressPolicyService({
      getConfig: config,
      mutateConfig: async () => {
        mutations += 1;
        throw new Error("must not mutate");
      },
      onPolicyChanged: () => {
        invalidations += 1;
        throw new Error("must not invalidate");
      },
    });
    const getter = {};
    Object.defineProperty(getter, "policy", {
      get() {
        throw new Error("secret");
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const invalidInputs = [
      null,
      [],
      { collection: "notes", policy: "future" },
      { collection: "notes", policy: "remote", extra: true },
      getter,
      revoked.proxy,
    ];
    for (const input of invalidInputs) {
      expect(await service.set(input)).toMatchObject({
        ok: false,
        code: "VALIDATION",
      });
    }
    expect(
      service.check({
        action: "export",
        caller: { authenticated: "yes", operationAuthorized: true },
        contentClass: "retrieval_trace",
        destinationZone: "remote",
      })
    ).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(
      service.check({
        action: "export",
        caller: { authenticated: true, operationAuthorized: true },
        collections: Array.from(
          { length: EGRESS_MAX_COLLECTIONS + 1 },
          (_, index) => `c${index}`
        ),
        contentClass: "retrieval_trace",
        destinationZone: "remote",
      })
    ).toMatchObject({ ok: false, code: "VALIDATION" });
    const sparseScope: string[] = [];
    sparseScope.length = 2;
    sparseScope[0] = "notes";
    const getterScope = ["notes"];
    Object.defineProperty(getterScope, "0", {
      get() {
        throw new Error("/private/collection");
      },
    });
    const revokedScope = Proxy.revocable(["notes"], {});
    revokedScope.revoke();
    const validCheck = {
      action: "export",
      caller: { authenticated: true, operationAuthorized: true },
      contentClass: "retrieval_trace",
      destinationZone: "remote",
    } as const;
    for (const collections of [
      null,
      "notes",
      [],
      ["notes", "notes"],
      ["Notes"],
      ["missing"],
      sparseScope,
      getterScope,
      revokedScope.proxy,
    ]) {
      const result = service.check({ ...validCheck, collections } as never);
      expect(result).toMatchObject({
        ok: false,
        code: "VALIDATION",
      });
      expect(JSON.stringify(result)).not.toContain("/private/");
    }
    expect(service.check({ ...validCheck, collections: ["missing"] })).toEqual({
      ok: false,
      code: "VALIDATION",
      error: "Invalid collection egress scope",
    });
    expect(mutations).toBe(0);
    expect(invalidations).toBe(0);
  });
});
