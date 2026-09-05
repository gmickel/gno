/** CPU-only: write a checked launch configuration; never launch a product process. */
const base = "/home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-js-evaluate";
const source = "/home/gordon/.cache/agent-tmp/fn1465-final-f64c41c9/package";
const pins = await Bun.file("/home/gordon/.cache/agent-tmp/fn1465-final-f64c41c9/package-receipt.json").json();
for (const [relative, expected] of Object.entries({ ...pins.shippedFileHashes, ...pins.helperFiles })) {
  const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(`${source}/${relative}`).bytes()).digest("hex");
  if (actual !== expected) throw Error(`Frozen package/helper mismatch: ${relative}`);
}
const paths = [
  pins.tarball,
  pins.helperArchive,
  `${base}/phase-parent.ts`, `${base}/phase-child.ts`, `${base}/iterator-observer.ts`, `${base}/ownership-observer.ts`,
  `${base}/init.json`, `${base}/fixture.json`,
  "/home/gordon/.cache/agent-tmp/gno-fn144-packed-surfaces-98252a9c/ask29/original-manifest.json",
];
// Pin installed product + helper bytes as well as original archive identities.
for (const pattern of ["src/**/*.ts", "evals/acceptance/**/*.ts"]) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: source })) paths.push(`${source}/${file}`);
}
for (const relative of ["evals/acceptance/compare.ts", "evals/acceptance/manifest.ts", "evals/acceptance/records.ts", "evals/agentic/canonical.ts"]) paths.push(`/home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-context-fixed/freeze/helper8b45/${relative}`);
const files = [];
for await (const name of new Bun.Glob("fn146.5-*.ts").scan({ cwd: import.meta.dir })) paths.push(`${import.meta.dir}/${name}`);
paths.push(`${import.meta.dir}/fn146.5-supervise.py`);
for (const path of paths) files.push({ path, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex") });
const request = { query: "Who owns the meadow migration?", collection: "probe", limit: 3, noExpand: true, noRerank: false, graph: false };
const { noExpand: _unsupportedMcpField, ...mcp } = request;
const config = {
  root: `/home/gordon/.cache/agent-tmp/fn1465-surfaces-${Date.now()}`,
  source, productCommit: pins.commit, productSha256: pins.packageSha256,
  helperCommit: pins.helperCommit, helperSha256: pins.helperArchiveSha256,
  phaseObserverSha256: files.find(row => row.path.endsWith("iterator-observer.ts"))!.sha256,
  files, initPath: `${base}/init.json`, fixturePath: `${base}/fixture.json`,
  observerRoot: base, bun: process.execPath, backend: "cuda", cudaPath: "/opt/cuda", port: 48655,
  serverLaunch: "observed-startServer",
  cliShutdownProbes: true,
  originalManifestPath: "/home/gordon/.cache/agent-tmp/gno-fn144-packed-surfaces-98252a9c/ask29/original-manifest.json",
  comparatorRoot: "/home/gordon/.cache/agent-tmp/gno-fn146-native-cancellation-context-fixed/freeze/helper8b45",
  queryBody: request, askBody: { ...request, verify: true }, mcpAskBody: { ...mcp, verify: true },
  status: "CPU_PREPARED_NOT_NATIVE_AUTHORIZED", prerequisites: ["host full gates and CUDA grant", "physical evidence analysis; no native PASS from preparation"],
};
const output = Bun.argv[2] ?? `${import.meta.dir}/fn146.5-run-config.json`;
await Bun.write(output, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ output, checkedFiles: files.length, nativeExecuted: false, product: pins.commit, helper: pins.helperCommit }));
