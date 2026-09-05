/** Run on Ivan only after final freeze is supplied. CPU/file preparation; no native inference. */
const descriptorPath = Bun.argv[2];
if (!descriptorPath) throw Error("Final product/helper descriptor required; no fallback to historical product");
const freeze = await Bun.file(descriptorPath).json();
for (const key of ["source", "productCommit", "productArchive", "productSha256", "comparatorRoot", "helperArchive", "helperSha256", "observerRoot"]) if (!freeze[key]) throw Error(`Missing final freeze ${key}`);
const historicalRoot = "/private/tmp/fn1445-ask-packed-9244d715.QBZRbQ/matched29-f8a278ef/candidate";
const setup = await Bun.file(`${historicalRoot}/setup.json`).json();
const manifest = await Bun.file(`${historicalRoot}/manifest.json`).json();
const request = setup.request;
if (request.query !== "Who owns the meadow migration?" || request.options.noRerank !== true || request.options.noExpand !== true || request.options.limit !== 3) throw Error("Historical Metal Ask scope mismatch");
if (setup.config.models.warmModelTtl !== 300000) throw Error("Historical TTL changed");
const sha = async (path: string) => { const hash = new Bun.CryptoHasher("sha256"); for await (const chunk of Bun.file(path).stream()) hash.update(chunk); return hash.digest("hex"); };
if (await sha(freeze.productArchive) !== freeze.productSha256 || await sha(freeze.helperArchive) !== freeze.helperSha256) throw Error("Final source/helper archive identity mismatch");
for (const model of manifest.models) if (!model.id.startsWith("file:") || await sha(model.id.slice(5)) !== model.sha256) throw Error(`Cached original model identity mismatch: ${model.id}`);
const root = `/private/tmp/fn1465-metal-${Date.now()}`;
const tools = import.meta.dir;
if (!tools.startsWith("/private/tmp/fn1465-tools-")) throw Error("Dedicated canonical QA tools root required");
const initPath = `${tools}/metal-init.json`, fixturePath = `${tools}/metal-fixture.json`;
await Bun.write(initPath, JSON.stringify({ config: setup.config, dbPath: `${historicalRoot}/data/index-default.sqlite`, cacheDir: `${root}/cache` }, null, 2));
await Bun.write(fixturePath, JSON.stringify({ models: manifest.models }, null, 2));
const paths = [freeze.productArchive, freeze.helperArchive, initPath, fixturePath, `${historicalRoot}/setup.json`, `${historicalRoot}/manifest.json`];
for (const pattern of ["src/**/*.ts", "evals/acceptance/**/*.ts"]) for await (const file of new Bun.Glob(pattern).scan({ cwd: freeze.source })) paths.push(`${freeze.source}/${file}`);
for (const file of ["phase-parent.ts", "phase-child.ts", "iterator-observer.ts", "ownership-observer.ts"]) paths.push(`${freeze.observerRoot}/${file}`);
for (const file of ["evals/acceptance/compare.ts", "evals/acceptance/manifest.ts", "evals/acceptance/records.ts", "evals/agentic/canonical.ts"]) paths.push(`${freeze.comparatorRoot}/${file}`);
const files = [];
for await (const name of new Bun.Glob("fn146.5-*.ts").scan({ cwd: tools })) paths.push(`${tools}/${name}`);
paths.push(`${tools}/fn146.5-supervise.py`);
for (const path of paths) files.push({ path, sha256: await sha(path) });
const body = { query: request.query, ...request.options };
const { noExpand: _unsupportedMcpField, ...mcp } = body;
const config = {
  ...freeze, root, files, initPath, fixturePath, backend: "metal", port: 48655,
  serverLaunch: freeze.serverLaunch ?? "observed-startServer",
  cliShutdownProbes: true,
  bun: "/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun",
  phaseObserverSha256: files.find(row => row.path.endsWith("iterator-observer.ts"))!.sha256,
  originalManifestPath: `${historicalRoot}/manifest.json`,
  queryBody: body, askBody: { ...body, verify: true }, mcpAskBody: { ...mcp, verify: true },
  policy: { stratum: "capacity-warning30-v1", warningBudgetSeconds: 30, critical: 4, rssMiB: 6144, isolatedPhaseSeconds: 120 },
  historicalConfiguration: { setupSha256: await sha(`${historicalRoot}/setup.json`), manifestSha256: await sha(`${historicalRoot}/manifest.json`), noRerank: true, originalCorpusUnchanged: true },
  warmPrimer: freeze.warmPrimer ?? null,
  status: "PREPARED_NOT_NATIVE_AUTHORIZED",
};
await Bun.write(`${tools}/metal-run.json`, JSON.stringify(config, null, 2));
console.log(JSON.stringify({ config: `${tools}/metal-run.json`, files: files.length, nativeExecuted: false, policy: config.policy }));
