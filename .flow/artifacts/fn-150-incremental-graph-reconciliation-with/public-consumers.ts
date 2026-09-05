// Synthetic public-surface QA; execute against the pinned archive, never the live index.
import { mkdir, unlink } from "node:fs/promises"; // Bun has no directory/unlink API.
const frozen = process.env.GRAPH_QA_SOURCE ?? "/home/gordon/.cache/agent-tmp/gno-fn150-qa/source";
const root = process.env.GRAPH_QA_ROOT ?? "/home/gordon/.cache/agent-tmp/gno-fn150-qa/public-v2";
const out = process.env.GRAPH_QA_OUT ??
  "/home/gordon/work/gno/.flow/artifacts/fn-150-incremental-graph-reconciliation-with";
const { SqliteAdapter } = await import(frozen + "/src/store/sqlite/adapter.ts");
const { SyncService } = await import(frozen + "/src/ingestion/index.ts");
const { createDefaultConfig } = await import(
  frozen + "/src/config/defaults.ts"
);
const { initialSources, mutate, mutations, rules } = await import(
  frozen + "/evals/fixtures/acceptance/graph-reconciliation/fixture.ts"
);
const { compareGraph, snapshot } = await import(
  frozen + "/evals/fixtures/acceptance/graph-reconciliation/oracle.ts"
);
const service = new SyncService();
const envFor = (where: string) => ({
  ...process.env,
  GNO_OFFLINE: "1",
  HF_HUB_OFFLINE: "1",
  GNO_CONFIG_DIR: where + "/config",
  GNO_DATA_DIR: where + "/data",
  GNO_CACHE_DIR: root + "/cache",
  TMPDIR: root,
});
async function layout(where: string, hint: string) {
  for (const dir of ["config", "data", "targets", "outside"])
    await mkdir(where + "/" + dir, { recursive: true });
  const collections = ["targets", "outside"].map((name) => ({
    name,
    path: where + "/" + name,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  }));
  const config = {
    ...createDefaultConfig(),
    collections,
    contentTypes: rules(hint),
  };
  await Bun.write(where + "/config/index.yml", Bun.YAML.stringify(config));
  const store = new SqliteAdapter();
  const opened = await store.open(
    where + "/data/index-default.sqlite",
    config.ftsTokenizer
  );
  if (!opened.ok) throw new Error(opened.error.message);
  await store.syncCollections(collections);
  return { store, collections };
}
async function cli(where: string, args: string[]) {
  const proc = Bun.spawn(
    [process.execPath, frozen + "/src/index.ts", ...args],
    { cwd: frozen, env: envFor(where), stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(JSON.stringify({ args, code, stdout, stderr }));
  return { body: JSON.parse(stdout), stderr };
}
async function consumer(where: string, ref: string, label: string) {
  const proc = Bun.spawn(
    [process.execPath, frozen + "/src/index.ts", "serve", "--port", "3385"],
    {
      cwd: frozen,
      env: envFor(where),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = new Response(proc.stdout).text(),
    stderr = new Response(proc.stderr).text();
  const url = "http://127.0.0.1:3385";
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(url + "/api/graph")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(100);
    }
    if (!ready) throw new Error("Graph HTTP server did not become ready");
    let session = "",
      requestId = 0;
    async function rpc(method: string, params: unknown, notification = false) {
      const response = await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: ++requestId }),
          method,
          params,
        }),
      });
      session = response.headers.get("mcp-session-id") ?? session;
      const raw = await response.text();
      if (notification) return null;
      const text =
        raw.startsWith("event:") || raw.startsWith("data:")
          ? raw
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("")
          : raw;
      const result = JSON.parse(text);
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    }
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fn150-synthetic-qa", version: "1" },
    });
    await rpc("notifications/initialized", {}, true);
    const result: Record<string, unknown> = {};
    for (const [name, args] of [
      ["graph", ["graph", "--include-isolated", "--json"]],
      [
        "scoped",
        ["graph", "--collection", "targets", "--include-isolated", "--json"],
      ],
      ["backlinks", ["backlinks", ref, "--json"]],
      ["traversal", ["graph", "query", ref, "--json"]],
      ["impact", ["impact", ref, "--json"]],
    ] as const)
      result["cli-" + name] = await cli(where, [...args]);
    const referenceId = (
      result["cli-impact"] as { body: { root: { id: string } } }
    ).body.root.id;
    const endpoints = [
      ["graph", "/api/graph?linkedOnly=false"],
      ["scoped", "/api/graph?collection=targets&linkedOnly=false"],
      [
        "backlinks",
        "/api/doc/" + encodeURIComponent(referenceId) + "/backlinks",
      ],
      ["impact", "/api/impact?ref=" + encodeURIComponent(ref)],
    ];
    for (const [name, path] of endpoints) {
      const response = await fetch(url + path);
      result["rest-" + name] = {
        status: response.status,
        body: await response.json(),
      };
    }
    const traversal = await fetch(url + "/api/graph/query", {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ doc: ref }),
    });
    result["rest-traversal"] = {
      status: traversal.status,
      body: await traversal.json(),
    };
    for (const [name, args] of [
      ["gno_graph", { linkedOnly: false }],
      ["gno_graph", { collection: "targets", linkedOnly: false }],
      ["gno_backlinks", { ref }],
      ["gno_graph_query", { ref }],
      ["gno_impact", { ref }],
    ] as const) {
      const key =
        name === "gno_graph" && "collection" in args
          ? "mcp-scoped"
          : "mcp-" + name;
      result[key] = await rpc("tools/call", { name, arguments: args });
    }
    for (const [key, value] of Object.entries(result)) {
      const response = value as { status?: number; isError?: boolean };
      if ((response.status && response.status !== 200) || response.isError)
        throw new Error(JSON.stringify({ key, value }));
    }
    await Bun.write(
      out + "/" + label + ".json",
      JSON.stringify(result, null, 2)
    );
    return result;
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
    await Bun.write(
      out + "/" + label + "-server.log",
      (await stdout) + "\n" + (await stderr)
    );
  }
}
const clean = (value: unknown, where: string): unknown => {
  if (Array.isArray(value)) return value.map((v) => clean(v, where));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !["durationMs", "elapsedMs", "timestamp", "generatedAt"].includes(k)
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, clean(v, where)])
    );
  return typeof value === "string"
    ? value.replaceAll(where, "$SYNTHETIC_ROOT")
    : value;
};
const sources = initialSources(),
  records = [];
const inc = root + "/incremental";
let previous: Record<string, string> = {},
  hint = "mentions";
for (const step of mutations) {
  mutate(sources, step);
  if (step === "config") hint = "attended";
  const current = await layout(inc, hint);
  for (const old of Object.keys(previous))
    if (!(old in sources)) await unlink(inc + "/" + old);
  for (const [path, body] of Object.entries(sources))
    if (previous[path] !== body)
      await Bun.write(inc + "/" + path, body as string);
  previous = { ...sources };
  const synced =
    step === "initial" || step === "source-disappears"
      ? await service.syncAll(current.collections, current.store, {
          contentTypeRules: rules(hint),
        })
      : await service.syncCollection(current.collections[0], current.store, {
          contentTypeRules: rules(hint),
        });
  const order = current.store
    .getRawDb()
    .query(
      "SELECT collection || '/' || rel_path AS path FROM documents ORDER BY id"
    )
    .all()
    .map((r: { path: string }) => r.path);
  const incrementalSnapshot = await snapshot(current.store);
  await current.store.close();
  const oracleRoot = root + "/oracle-" + step,
    oracle = await layout(oracleRoot, hint);
  for (const [path, body] of Object.entries(sources))
    await Bun.write(oracleRoot + "/" + path, body as string);
  for (const path of order) {
    if (!(path in sources)) continue;
    const collection = oracle.collections.find((c: { name: string }) =>
      path.startsWith(c.name + "/")
    );
    await service.syncPaths(
      collection,
      oracle.store,
      [path.slice(collection.name.length + 1)],
      { contentTypeRules: rules(hint) }
    );
  }
  const errors = await service.reconcileTypedEdges(oracle.store, {
    contentTypeRules: rules(hint),
  });
  if (errors.length) throw new Error(JSON.stringify(errors));
  const comparison = compareGraph(
    step,
    await snapshot(oracle.store),
    incrementalSnapshot
  );
  if (!comparison.passed) throw new Error(JSON.stringify(comparison));
  await oracle.store.close();
  const ref =
    step === "rename" ||
    step === "title" ||
    step === "config" ||
    step === "source-disappears"
      ? "gno://targets/moved.md"
      : "targets/opaque.md" in sources
        ? "gno://targets/opaque.md"
        : "gno://targets/anchor.md";
  const candidate = await consumer(inc, ref, step + "-incremental");
  const expected = await consumer(oracleRoot, ref, step + "-oracle");
  const differences = Object.keys(expected).filter(
    (key) =>
      JSON.stringify(clean(expected[key], oracleRoot)) !==
      JSON.stringify(clean(candidate[key], inc))
  );
  records.push({ step, ref, comparison, differences, synced });
  await Bun.write(
    out + "/public-matrix.json",
    JSON.stringify(
      {
        commit: process.env.GRAPH_QA_COMMIT ?? "dd38f777",
        normalization:
          "Only runtime timing/generated timestamps and isolated synthetic root prefixes; raw responses retained",
        records,
      },
      null,
      2
    )
  );
  console.log(step, differences.length ? JSON.stringify(differences) : "equal");
}
