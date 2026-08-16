/**
 * Fixture / probe / matrix / benchmark ops for File Provider smoke (non-production).
 */

// node:fs/promises — structural mkdir/readdir; no Bun equivalent
import { mkdir, readdir } from "node:fs/promises";
// node:path — Bun has no path utilities
import { basename, join } from "node:path";

import {
  CORPUS_FILE_COUNT,
  readContentUnderActivePolicy,
  loadAvailabilityObserver,
  loadIoPolicyPort,
  type AvailabilityObserver,
  type IoPolicyPort,
  type MatrixRow,
  type ProbeKind,
  type ProviderLabel,
  type RowVerdict,
  redactToken,
  resolveFixtureChild,
  withNoMaterializePolicy,
} from "./macos-file-provider-smoke-lib";

function corpusRelPaths(): string[] {
  return Array.from({ length: CORPUS_FILE_COUNT }, (_, i) => {
    const name = `doc-${String(i).padStart(4, "0")}.md`;
    return i % 6 === 0 ? join("nested", name) : name;
  });
}

export async function createDedicatedFixture(
  rootReal: string,
  fixtureId: string,
  dryRun: boolean
): Promise<Record<string, unknown>> {
  const child = await resolveFixtureChild(rootReal, fixtureId, {
    mustNotExist: true,
  });
  const paths = corpusRelPaths();
  if (dryRun) {
    return {
      action: "create-fixture",
      dryRun: true,
      root: redactToken(rootReal),
      fixtureId: redactToken(fixtureId),
      fileCount: paths.length,
      wouldCreate: true,
    };
  }
  // Exclusive first mkdir closes the check/create race and refuses any child
  // that appeared after resolveFixtureChild's preflight.
  await mkdir(child);
  await mkdir(join(child, "nested"));
  for (const rel of paths) {
    await Bun.write(
      join(child, rel),
      `# fixture ${rel}\n deterministic-fn118\n`
    );
  }
  await Bun.write(
    join(child, "race-target.md"),
    "# race target\n deterministic-fn118\n"
  );
  return {
    action: "create-fixture",
    dryRun: false,
    root: redactToken(rootReal),
    fixtureId: redactToken(fixtureId),
    fileCount: paths.length + 1,
    created: true,
  };
}

export async function listFixtureFiles(fixtureRoot: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [fixtureRoot];
  while (stack.length > 0) {
    const dir = stack.pop() ?? "";
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

export async function runProbe(options: {
  fixtureRoot: string;
  probe: ProbeKind;
  targetPath?: string;
  observer?: AvailabilityObserver | null;
  policy?: IoPolicyPort | null;
}): Promise<Record<string, unknown>> {
  const observer = options.observer ?? loadAvailabilityObserver();
  if (!observer) {
    return { status: "BLOCKED", reason: "availability_observer_unavailable" };
  }
  const files = await listFixtureFiles(options.fixtureRoot);
  const target = options.targetPath ?? files[0];
  if (!target) {
    return { status: "FAIL", reason: "empty_fixture" };
  }
  if (!files.includes(target)) {
    return { status: "FAIL", reason: "target_outside_fixture" };
  }
  const before = observer.observe(target);
  let detail: Record<string, unknown> = {};
  if (options.probe === "metadata") {
    detail = { observed: before.dataless };
  } else if (options.probe === "traversal") {
    detail = { entryCount: (await readdir(options.fixtureRoot)).length };
  } else {
    const guarded = await withNoMaterializePolicy(
      async () =>
        readContentUnderActivePolicy(
          target,
          options.policy ?? loadIoPolicyPort()
        ),
      options.policy ?? loadIoPolicyPort()
    );
    if (!guarded.ok) {
      return {
        status: "BLOCKED",
        reason: guarded.error,
        observer: {
          kind: observer.kind,
          intermediateDirectoryCaveat: observer.intermediateDirectoryCaveat,
        },
        before: { dataless: before.dataless, stFlags: before.stFlags },
      };
    }
    detail = {
      read: {
        ok: guarded.value.ok,
        classification: guarded.value.classification,
        errno: guarded.value.errno,
        bytesRead: guarded.value.bytesRead,
      },
    };
  }
  const after = observer.observe(target);
  if (!before.ok || !after.ok) {
    return {
      status: "BLOCKED",
      reason: "availability_observe_failed",
      probe: options.probe,
      before: { dataless: before.dataless, errno: before.errno },
      after: { dataless: after.dataless, errno: after.errno },
    };
  }
  const materializationSuspected =
    before.dataless === true && after.dataless === false;
  const read = (
    detail as {
      read?: { ok?: boolean; classification?: string };
    }
  ).read;
  const guardedReadAccepted =
    options.probe !== "guarded-read" ||
    (before.dataless === true
      ? read?.classification === "EDEADLK"
      : read?.ok === true);
  return {
    status: materializationSuspected || !guardedReadAccepted ? "FAIL" : "PASS",
    probe: options.probe,
    observer: {
      kind: observer.kind,
      intermediateDirectoryCaveat: observer.intermediateDirectoryCaveat,
    },
    before: { dataless: before.dataless, stFlags: before.stFlags },
    after: { dataless: after.dataless, stFlags: after.stFlags },
    materializationSuspected,
    detail,
  };
}

export async function runMatrixRow(options: {
  fixtureRoot: string;
  row: MatrixRow;
  provider: ProviderLabel;
  observer?: AvailabilityObserver | null;
  policy?: IoPolicyPort | null;
  raceDelayMs?: number;
}): Promise<Record<string, unknown>> {
  const observer = options.observer ?? loadAvailabilityObserver();
  if (!observer) {
    return {
      provider: options.provider,
      row: options.row,
      verdict: "BLOCKED" satisfies RowVerdict,
      reason: "availability_observer_unavailable",
    };
  }
  const files = await listFixtureFiles(options.fixtureRoot);
  const raceTarget = files.find((p) => basename(p) === "race-target.md");
  const target =
    options.row === "cloud-only" ||
    options.row === "classification-to-read-race"
      ? (raceTarget ?? files[0])
      : (files.find((path) => path !== raceTarget) ?? files[0]);
  if (!target) {
    return {
      provider: options.provider,
      row: options.row,
      verdict: "FAIL" satisfies RowVerdict,
      reason: "empty_fixture",
    };
  }
  const snap = observer.observe(target);
  const nestedSnap = observer.observe(join(options.fixtureRoot, "nested"));

  if (options.row === "local" || options.row === "cached-unpinned") {
    if (snap.dataless === true) {
      return {
        provider: options.provider,
        row: options.row,
        verdict: "NOT AVAILABLE" satisfies RowVerdict,
        reason: "fixture_target_is_dataless",
      };
    }
    const probes = [];
    for (const probe of ["metadata", "traversal", "guarded-read"] as const) {
      probes.push(
        await runProbe({
          fixtureRoot: options.fixtureRoot,
          probe,
          observer,
          policy: options.policy,
        })
      );
    }
    return {
      provider: options.provider,
      row: options.row,
      verdict: (probes.some((p) => p.status !== "PASS")
        ? "FAIL"
        : "PASS") satisfies RowVerdict,
      probes,
    };
  }

  if (options.row === "cloud-only") {
    if (snap.dataless !== true) {
      return {
        provider: options.provider,
        row: options.row,
        verdict: "NOT AVAILABLE" satisfies RowVerdict,
        reason: "host_must_prepare_dataless_target",
        observedDataless: snap.dataless,
      };
    }
    const probeTarget = (probeKind: ProbeKind) =>
      runProbe({
        fixtureRoot: options.fixtureRoot,
        probe: probeKind,
        targetPath: target,
        observer,
        policy: options.policy,
      });
    const metadataProbe = await probeTarget("metadata");
    const traversalProbe = await probeTarget("traversal");
    const probe = await probeTarget("guarded-read");
    const probes = [metadataProbe, traversalProbe, probe];
    const read = (
      probe.detail as { read?: { classification?: string } } | undefined
    )?.read;
    const after = probe.after as { dataless?: boolean } | undefined;
    const pass =
      probe.status === "PASS" &&
      read?.classification === "EDEADLK" &&
      after?.dataless === true &&
      probe.materializationSuspected !== true;
    return {
      provider: options.provider,
      row: options.row,
      verdict: (pass ? "PASS" : "FAIL") satisfies RowVerdict,
      probes,
    };
  }

  if (options.row === "nested-dataless-directory") {
    if (nestedSnap.dataless !== true) {
      return {
        provider: options.provider,
        row: options.row,
        verdict: "NOT AVAILABLE" satisfies RowVerdict,
        reason: "host_must_prepare_dataless_nested_directory",
        observedDataless: nestedSnap.dataless,
      };
    }
    const after = observer.observe(join(options.fixtureRoot, "nested"));
    const preserved = after.ok && after.dataless === true;
    return {
      provider: options.provider,
      row: options.row,
      verdict: (preserved ? "PASS" : "FAIL") satisfies RowVerdict,
      note: "classified nested directory as dataless; descent skipped by harness",
      before: { dataless: nestedSnap.dataless, stFlags: nestedSnap.stFlags },
      after: { dataless: after.dataless, stFlags: after.stFlags },
      materializationSuspected:
        nestedSnap.dataless === true && after.dataless === false,
      observer: {
        kind: observer.kind,
        intermediateDirectoryCaveat: observer.intermediateDirectoryCaveat,
      },
    };
  }

  if (options.row === "classification-to-read-race") {
    if (!options.raceDelayMs || options.raceDelayMs < 1) {
      return {
        provider: options.provider,
        row: options.row,
        verdict: "BLOCKED" satisfies RowVerdict,
        reason: "race_delay_required_for_host_state_transition",
        before: { dataless: snap.dataless },
      };
    }
    if (snap.dataless !== false) {
      return {
        provider: options.provider,
        row: options.row,
        verdict: "NOT AVAILABLE" satisfies RowVerdict,
        reason: "race_requires_initially_materialized_target",
        before: { dataless: snap.dataless },
      };
    }
    await Bun.sleep(options.raceDelayMs);
    const probe = await runProbe({
      fixtureRoot: options.fixtureRoot,
      probe: "guarded-read",
      targetPath: target,
      observer,
      policy: options.policy,
    });
    const raceRead = (
      probe.detail as { read?: { classification?: string } } | undefined
    )?.read;
    const raceAfter = probe.after as { dataless?: boolean } | undefined;
    const reproduced =
      raceRead?.classification === "EDEADLK" &&
      raceAfter?.dataless === true &&
      probe.materializationSuspected !== true;
    return {
      provider: options.provider,
      row: options.row,
      verdict: (reproduced ? "PASS" : "NOT AVAILABLE") satisfies RowVerdict,
      reason: reproduced ? undefined : "state_transition_not_reproduced",
      raceDelayMs: options.raceDelayMs,
      before: { dataless: snap.dataless },
      probe,
    };
  }

  if (options.row === "pinned-offline") {
    return {
      provider: options.provider,
      row: options.row,
      verdict: "BLOCKED" satisfies RowVerdict,
      reason: "provider_offline_state_not_safely_induced",
      before: { dataless: snap.dataless, stFlags: snap.stFlags },
    };
  }

  if (options.row === "partial-content") {
    return {
      provider: options.provider,
      row: options.row,
      verdict: "NOT AVAILABLE" satisfies RowVerdict,
      reason: "no_safe_partial_range_control",
      before: { dataless: snap.dataless, stFlags: snap.stFlags },
    };
  }

  return {
    provider: options.provider,
    row: options.row,
    verdict: "NOT AVAILABLE" satisfies RowVerdict,
    reason: "host_must_prepare_provider_state",
    observedDataless: snap.dataless,
  };
}
