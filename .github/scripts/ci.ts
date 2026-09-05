/** Conservative CI selection: only explicitly understood paths can omit jobs. */
export interface Selection {
  core: boolean;
  clipper: boolean;
  windows: boolean;
  latest: boolean;
}

const docsOnly = /^(?:[^/]+\.md|docs\/.*\.md|\.flow\/.*|\.github\/[^/]+\.md)$/;
// These subsystems do not participate in browser clipper capture. New paths
// remain selected until their independence is understood and tested.
const clipperIndependent =
  /^(?:src|test)\/(?:llm|pipeline|embed|mcp|sdk|bench)\//;
const windowsIndependent =
  /^(?:browser-extension\/|(?:src|test)\/serve\/public\/)/;

export function selectJobs(
  paths: string[] | null,
  event: string,
  labels: string[] = []
): Selection {
  const latest = event === "schedule" || event === "workflow_dispatch";
  // Missing/unavailable diff is full coverage, never an empty successful result.
  if (paths === null || latest) {
    return { core: true, clipper: true, windows: true, latest };
  }
  const changed = paths.filter((path) => !docsOnly.test(path));
  const core = changed.length > 0;
  return {
    core,
    clipper: changed.some((path) => !clipperIndependent.test(path)),
    windows:
      event === "push" ||
      labels.includes("test-windows") ||
      changed.some((path) => !windowsIndependent.test(path)),
    latest,
  };
}

interface Job {
  result: string;
  outputs?: Record<string, string>;
}

export function checkResults(needs: Record<string, Job>): void {
  if (needs.changes?.result !== "success") {
    throw new Error("Change classification did not succeed");
  }
  const outputs = needs.changes.outputs ?? {};
  for (const key of ["core", "clipper", "windows", "latest"]) {
    if (outputs[key] !== "true" && outputs[key] !== "false") {
      throw new Error(`Missing or invalid selection: ${key}`);
    }
  }
  const expected: Record<string, boolean> = {
    lint: true,
    test: outputs.core === "true",
    "watcher-cross-platform": outputs.core === "true",
    "test-windows": outputs.windows === "true",
    "clipper-e2e": outputs.clipper === "true",
  };
  for (const [name, required] of Object.entries(expected)) {
    const result = needs[name]?.result;
    if (result !== (required ? "success" : "skipped")) {
      throw new Error(
        `${name}: expected ${required ? "success" : "skipped"}, got ${result}`
      );
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] === "result") {
    checkResults(JSON.parse(process.env.CI_NEEDS ?? "{}"));
    console.log("All selected CI jobs passed");
  } else if (process.argv[2] === "classify") {
    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    const event = await Bun.file(process.env.GITHUB_EVENT_PATH ?? "").json();
    let paths: string[] | null = null;
    const base = event.pull_request?.base?.sha ?? event.before;
    const head = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA;
    if (
      typeof base === "string" &&
      /^[a-f0-9]{40}$/.test(base) &&
      !/^0+$/.test(base) &&
      typeof head === "string" &&
      /^[a-f0-9]{40}$/.test(head)
    ) {
      const range = event.pull_request
        ? `${base}...${head}`
        : `${base}..${head}`;
      const diff = Bun.spawnSync([
        "git",
        "diff",
        "--no-renames",
        "--name-only",
        "-z",
        range,
        "--",
      ]);
      if (diff.exitCode === 0) {
        paths = diff.stdout.toString().split("\0").filter(Boolean);
      }
    }
    const selection = selectJobs(
      paths,
      eventName,
      (event.pull_request?.labels ?? []).map(
        (label: { name: string }) => label.name
      )
    );
    const output =
      Object.entries(selection)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n";
    const file = Bun.file(process.env.GITHUB_OUTPUT ?? "");
    await Bun.write(
      file,
      ((await file.exists()) ? await file.text() : "") + output
    );
    console.log(output);
  } else {
    throw new Error("Expected classify or result");
  }
}
