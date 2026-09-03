/**
 * Deterministic fake `gno` runner for the plugin unit suite. Scripts map a
 * subcommand (first non-global arg) to a canned result; every call is
 * recorded so tests can assert the exact argv the plugin sent.
 */

import type { GnoRunResult, GnoRunner } from "../src/gno-cli";

export interface FakeCall {
  binary: string;
  args: string[];
  timeoutMs: number;
}

export type FakeScript = Record<
  string,
  GnoRunResult | ((args: string[]) => GnoRunResult)
>;

export const ok = (stdout: string): GnoRunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  notFound: false,
});

export const failed = (
  code: number,
  stdout = "",
  stderr = ""
): GnoRunResult => ({
  code,
  stdout,
  stderr,
  timedOut: false,
  notFound: false,
});

export const timedOut: GnoRunResult = {
  code: null,
  stdout: "",
  stderr: "",
  timedOut: true,
  notFound: false,
};

export const notFound: GnoRunResult = {
  code: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  notFound: true,
};

export const SEARCH_HIT = {
  docid: "#abc12345",
  score: 0.91,
  uri: "gno://openclaw-memory/memory/2026-09-01.md",
  line: 3,
  title: "2026-09-01",
  snippet:
    'the queue rewrite was dropped in favor of the ledger approach ("teal-heron-19")',
  snippetRange: { startLine: 3, endLine: 3 },
  source: {
    relPath: "memory/2026-09-01.md",
    mime: "text/markdown",
    ext: ".md",
    sourceHash: "f".repeat(64),
  },
  conversion: { mirrorHash: "a".repeat(64) },
};

export function searchPayload(results: unknown[] = [SEARCH_HIT]): string {
  return JSON.stringify({
    results,
    meta: { query: "q", mode: "bm25", totalResults: results.length },
  });
}

export function collectionList(
  entries: { name: string; path: string }[]
): string {
  return JSON.stringify(
    entries.map((e) => ({ ...e, pattern: "**/*", include: [], exclude: [] }))
  );
}

export const INDEX_OK = JSON.stringify({
  syncResult: {
    totalFilesAdded: 1,
    totalFilesUpdated: 0,
    totalFilesRemoved: 0,
  },
  embedSkipped: true,
});

/** Subcommand key: the first arg that is not a global flag or its value. */
function subcommandOf(args: string[]): string {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--config" || arg === "--index") {
      i += 2;
      continue;
    }
    if (arg === "collection" || arg === "context")
      return `${arg} ${args[i + 1] ?? ""}`.trim();
    return arg;
  }
  return "";
}

export function fakeGno(script: FakeScript): {
  runner: GnoRunner;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const runner: GnoRunner = async (binary, args, options) => {
    const argv = [...args];
    calls.push({ binary, args: argv, timeoutMs: options.timeoutMs });
    const entry = script[subcommandOf(argv)];
    if (entry === undefined) {
      return failed(2, "", `fake gno: no script for ${argv.join(" ")}`);
    }
    return typeof entry === "function" ? entry(argv) : entry;
  };
  return { runner, calls };
}

export const VERSION_OK = ok("1.42.0\n");
