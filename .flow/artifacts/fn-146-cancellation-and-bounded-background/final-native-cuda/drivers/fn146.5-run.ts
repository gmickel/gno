/** One-command physical driver. --preflight runs only loopback mock transports. */
import { mkdir, realpath, rename } from "node:fs/promises"; // Bun lacks directory/canonical-path/rename APIs.
import { Database } from "bun:sqlite";
import { drainStream } from "./fn146.5-drain";
import { HttpWire, StdioWire } from "./fn146.5-wire";
import { compareResponses } from "./fn146.5-compare";
const arg = Bun.argv.slice(2);
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const rpc = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function preflight() {
  const rows: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body: any = await req.json(); rows.push(body);
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "owned-mock" } });
    if (body.id) return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return new Response(null, { status: 202 });
  }});
  try {
    const wire = new HttpWire(`http://127.0.0.1:${server.port}`, async () => {});
    await wire.initialize();
    const response: any = await wire.send("call", "/mcp", rpc(1, "gno_query", { query: "synthetic" }));
    await wire.send("cancel", "/mcp", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    if (wire.session !== "owned-mock" || response.parsed.id !== 1 || rows[3].params.requestId !== 1) throw Error("HTTP protocol preflight failed");
    const code = `const pending=new Set();for await (const line of console){if(!line.trim())continue;const x=JSON.parse(line);if(x.method==='tools/call'){pending.add(x.id);continue;}if(x.method==='notifications/cancelled'&&pending.delete(x.params.requestId)){console.log(JSON.stringify({jsonrpc:'2.0',id:x.params.requestId,error:{code:-32800,message:'mock cancelled'}}));continue;}if(x.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{protocolVersion:'2025-06-18'}}));}`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, TMPDIR: "/home/gordon/.cache/agent-tmp" } });
    const stdio = new StdioWire(child, async () => {});
    await stdio.initialize(); const pendingCall = stdio.send(rpc(2, "gno_query", { query: "synthetic" }));
    await stdio.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    if ((await pendingCall).error?.code !== -32800) throw Error("Stdio active notification mismatch");
    stdio.close(); await stdio.pumping; if (await child.exited !== 0) throw Error(`Stdio mock failed: ${await new Response(child.stderr).text()}`);
    console.log(JSON.stringify({ status: "CPU_PREFLIGHT_PASS", native: false, checks: ["HTTP initialization/session", "SSE parsing", "exact notification ID", "stdio initialization/call/notification/close"] }));
  } finally { server.stop(true); }
}

async function main(configPath: string) {
  if (!arg.includes("--native") || process.env.GNO_QA_SUPERVISED !== "1") throw Error("Physical run requires owned supervisor, --native and host GPU grant");
  const spec: any = await Bun.file(configPath).json();
  const root = spec.root;
  const allowedPrefix = spec.backend === "metal" ? "/private/tmp/fn1465-" : "/home/gordon/.cache/agent-tmp/fn1465-";
  if (!root.startsWith(allowedPrefix) || await Bun.file(`${root}/run.json`).exists()) throw Error("New owned task-cache root required");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw Error("Canonical scratch root required");
  const source = await realpath(spec.source);
  if (!spec.productSha256 || !spec.helperSha256 || !spec.phaseObserverSha256) throw Error("Product/helper/observer pins required");
  for (const pin of spec.files ?? []) if (hash(await Bun.file(pin.path).bytes()) !== pin.sha256) throw Error(`Pin mismatch: ${pin.path}`);
  if (!(spec.files?.length > 3)) throw Error("Explicit checked source/package, helper, observer and fixture pins required");
  const init = await Bun.file(spec.initPath).json();
  const fixture = await Bun.file(spec.fixturePath).json();
  const comparisonManifest = await Bun.file(spec.originalManifestPath).json();
  if (spec.warmPrimer && (!["/api/query", "/api/ask"].includes(spec.warmPrimer.path) || !spec.warmPrimer.body || !spec.warmPrimer.provenance)) throw Error("Warm primer requires an explicit supported request and original provenance");
  const save = (name: string, value: unknown) => Bun.write(`${root}/${name}.json`, JSON.stringify(value, null, 2));
  await save("run", { spec, started: Date.now(), status: "running" });
  const environment: Record<string, string> = { PATH: process.env.PATH ?? "", GNO_OFFLINE: "1", GNO_ALLOW_DOWNLOAD: "0", GNO_LLAMA_BUILD: "never", GNO_LLAMA_GPU: spec.backend, TMPDIR: root, NODE_ENV: "production" };
  if (spec.backend === "cuda") environment.CUDA_PATH = spec.cudaPath;
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", GNO_CONFIG_DIR: "config", GNO_DATA_DIR: "data", GNO_CACHE_DIR: "cache" })) { await mkdir(`${root}/${dir}`, { recursive: true }); environment[key] = `${root}/${dir}`; }
  const dbPath = `${root}/data/index-default.sqlite`;
  const seed = new Database(init.dbPath, { readonly: true });
  await Bun.write(dbPath, seed.serialize()); seed.close();
  const config = structuredClone(init.config);
  // Explicit isolated-fixture permission: accepted gno_embed jobs are write-gated.
  config.gateway = { ...config.gateway, enableWrite: true, toolProfile: "full" };
  const backlog = `${root}/backlog`; await mkdir(backlog);
  const corpus = [];
  const backgroundCount = spec.backgroundDocumentCount ?? 64;
  if (![64, 1024].includes(backgroundCount)) throw Error("Undeclared background fixture size");
  for (let i = 0; i < backgroundCount; i++) {
    const content = `# Synthetic background record ${i}\n\nBackground indexing receipt ${i}. This fixture describes numbered archive storage and does not change meadow migration ownership.\n`;
    const path = `${backlog}/record-${i}.md`; await Bun.write(path, content); corpus.push({ path, sha256: hash(content) });
  }
  config.collections.push({ name: "qa-background", path: backlog, pattern: "**/*.md", include: [], exclude: [] });
  await save("backlog-manifest", { scope: "new background-only collection; unchanged probe provenance", files: corpus });
  await Bun.write(`${root}/config.yml`, JSON.stringify(config, null, 2));
  const cli = [spec.bun, "--no-env-file", `${source}/src/index.ts`, "--config", `${root}/config.yml`, "--index", "default"];
  const owned: Bun.Subprocess[] = [];
  const receipts: any[] = [];
  let launchId = 0;
  let previousPhase: { child: Bun.Subprocess; root: string; released: boolean } | undefined;
  async function launch(kind: "serve" | "mcp" | "daemon", forceCli = false) {
    if (previousPhase && !previousPhase.released) throw Error("Previous HTTP/MCP phase has not proved complete owned-process release");
    if (kind !== "mcp") { const probe = Bun.serve({ hostname: "127.0.0.1", port: spec.port, fetch: () => new Response("owned port reservation") }); probe.stop(true); }
    const runRoot = `${root}/launch-${++launchId}`; await mkdir(`${runRoot}/capture`, { recursive: true, mode: 0o700 });
    await Bun.write(`${root}/supervisor-phase.json.partial`, JSON.stringify({ id: `launch-${launchId}`, kind, startedAt: Date.now(), previousReleased: !previousPhase || previousPhase.released }));
    await rename(`${root}/supervisor-phase.json.partial`, `${root}/supervisor-phase.json`);
    const settings = { source, root: runRoot, observerRoot: spec.observerRoot, models: fixture.models };
    const observedServer = kind === "serve" && !forceCli && spec.serverLaunch === "observed-startServer";
    const command = [cli[0], cli[1], "--preload", `${import.meta.dir}/fn146.5-surface-preload.ts`, ...(observedServer ? [`${import.meta.dir}/fn146.5-server-launch.ts`, JSON.stringify({ configPath: `${root}/config.yml`, index: "default", host: "127.0.0.1", port: spec.port })] : [...cli.slice(2), kind, ...(kind !== "mcp" ? ["--host", "127.0.0.1", "--port", String(spec.port)] : [])])];
    const child = Bun.spawn(command, { cwd: source, env: { ...environment, GNO_SURFACE_QA: JSON.stringify(settings) }, stdin: "pipe", stdout: "pipe", stderr: "pipe" }); owned.push(child);
    void drainStream(`${runRoot}/stderr.log`, child.stderr);
    const wire = kind !== "mcp" ? new HttpWire(`http://127.0.0.1:${spec.port}`, async (id, value) => { await Bun.write(`${runRoot}/${id}.json`, JSON.stringify(value, null, 2)); }) : new StdioWire(child, async (id, value) => { await Bun.write(`${runRoot}/${id}.json`, JSON.stringify(value, null, 2)); });
    if (kind !== "mcp") { void drainStream(`${runRoot}/stdout.log`, child.stdout); await wait(async () => { if (child.exitCode !== null) throw Error("Owned server exited before readiness"); try { return (await fetch(`http://127.0.0.1:${spec.port}${kind === "daemon" ? "/api/status" : "/api/health"}`)).ok; } catch { return false; } }, 15000); }
    await save(`launch-${launchId}`, { command, pid: child.pid, root: runRoot, stratum: observedServer ? "actual startServer with transparent real runtime-factory observer; not CLI entry" : "actual packaged CLI entry" });
    const phase = { child, wire, root: runRoot, released: false };
    previousPhase = phase;
    return phase;
  }
  async function wait(check: () => Promise<boolean>, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await Bun.sleep(5); } throw Error("Observation deadline; scenario unexercised/incomplete"); }
  async function rows(path: string) { try { return (await Bun.file(path).text()).split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
  async function active(runRoot: string, after: number) {
    const events = await rows(`${runRoot}/phases.jsonl`);
    return events.findLast((row: any) => row.at >= after && row.event.kind === "evaluation-pending" && row.event.method === "next" && !events.some((end: any) => end.pid === row.pid && end.event.id === row.event.id && end.event.evaluationId === row.event.evaluationId && ["evaluation-end", "evaluation-error"].includes(end.event.kind)));
  }
  async function snapshot(name: string) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
      const data = tables.map(table => {
        try { return { ...table, rows: db.query(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).all().map((row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { blobSha256: hash(value), length: value.length } : value]))) }; } catch (error) { return { ...table, error: String(error) }; }
      });
      await save(name, { tables: data, integrity: db.query("PRAGMA quick_check").all() });
    } finally { db.close(); }
  }
  async function coverage(name: string) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const model = fixture.models.find((row: any) => row.role === "embedding").id;
      const expected = db.query("SELECT d.id,c.seq,c.mirror_hash FROM documents d JOIN content_chunks c ON c.mirror_hash=d.mirror_hash WHERE d.active=1 AND d.collection='qa-background' ORDER BY d.id,c.seq").all() as any[];
      const completed = db.query("SELECT o.document_id AS id,o.seq,o.mirror_hash,o.partition_id,v.input_hash FROM vector_owners o JOIN documents d ON d.id=o.document_id JOIN vector_partitions p ON p.partition_id=o.partition_id JOIN vector_variants v ON v.variant_id=o.variant_id AND v.partition_id=o.partition_id WHERE d.active=1 AND d.collection='qa-background' AND o.mirror_hash=d.mirror_hash AND p.model=? AND p.state='active' ORDER BY o.document_id,o.seq").all(model) as any[];
      const key = (row: any) => `${row.id}:${row.seq}:${row.mirror_hash}`;
      const keys = new Set(completed.map(key));
      const result = { model, expected, completed, missing: expected.filter(row => !keys.has(key(row))), duplicateKeys: completed.length - keys.size, note: "Active exact-model variant owner coverage; complete input hash provenance retained for validation" };
      await save(name, result); return result;
    } finally { db.close(); }
  }
  async function stop(run: any, label: string) {
    const known = new Set<number>([run.child.pid]);
    const processSnapshot = async () => {
      const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(ps.stdout).text();
      if (await ps.exited !== 0) throw Error("Cannot prove owned-process absence: ps failed");
      return text.split("\n").map(line => line.trim().split(/\s+/, 3)).filter(row => row.length >= 2).map(row => ({ pid: Number(row[0]), ppid: Number(row[1]) }));
    };
    const recordNativeChildren = async () => {
      const file = Bun.file(`${run.root}/capture/children.json`);
      if (!await file.exists()) return;
      for (const event of await file.json()) {
        const identity = event.identity;
        if (identity.parentPid !== run.child.pid || identity.entry !== `${source}/src/llm/native-worker/entry.ts` || !Number.isInteger(identity.pid) || identity.pid <= 0) throw Error("Invalid owned native child identity at phase boundary");
        known.add(identity.pid);
      }
    };
    await recordNativeChildren();
    const before = await processSnapshot();
    for (let changed = true; changed;) {
      changed = false;
      for (const row of before) if (known.has(row.ppid) && !known.has(row.pid)) { known.add(row.pid); changed = true; }
    }
    const start = Date.now();
    if (run.child.exitCode === null) run.child.kill("SIGTERM");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([run.child.exited, new Promise<string>(resolve => { timeout = setTimeout(() => resolve("shared-budget-exceeded"), 11000); })]);
    clearTimeout(timeout);
    await save(label, { start, elapsedMs: Date.now() - start, exit, pid: run.child.pid });
    if (exit === "shared-budget-exceeded") throw Error("Shutdown shared11s budget exceeded");
    let remaining: number[] = [];
    do {
      // Include children born during shutdown; parent exit alone cannot release the GPU slot.
      await recordNativeChildren();
      remaining = (await processSnapshot()).filter(row => known.has(row.pid)).map(row => row.pid);
      if (!remaining.length) break;
      await Bun.sleep(25);
    } while (Date.now() - start < 11000);
    const elapsedMs = Date.now() - start;
    await save(`${label}-phase-release`, { parentPid: run.child.pid, knownOwnedPids: [...known], remaining, elapsedMs, released: !remaining.length && elapsedMs <= 11000 });
    if (remaining.length || elapsedMs > 11000) throw Error("Owned phase release not proved within11s; next GPU phase forbidden");
    run.released = true;
  }
  try {
    const check = Bun.spawn([...cli, "index", "--no-embed", "--json"], { cwd: source, env: environment, stdout: "pipe", stderr: "pipe" }); owned.push(check);
    await Promise.all([drainStream(`${root}/index.stdout`, check.stdout), drainStream(`${root}/index.stderr`, check.stderr)]);
    if (await check.exited !== 0) throw Error("Synthetic backlog indexing failed");
    await snapshot("before");
    const initialCoverage = await coverage("before-coverage");
    if (initialCoverage.expected.length <= 32 || initialCoverage.missing.length <= 32) throw Error("Distinct >32-chunk backlog not established");
    comparisonManifest.identity = { ...comparisonManifest.identity, commit: spec.productCommit, indexId: "default", indexSha256: hash(await Bun.file(dbPath).bytes()) };
    comparisonManifest.fixtureVersion += "-fn1465-background";
    comparisonManifest.fixtures = [...comparisonManifest.fixtures, { path: "backlog-manifest.json", sha256: hash(await Bun.file(`${root}/backlog-manifest.json`).bytes()) }];
    let run = await launch("serve"); let http = run.wire as HttpWire;
    const query = spec.queryBody;
    const ask = spec.askBody;
    if (spec.scenarioPhase === "fairness-only") {
      const idle = await http.send("fairness-idle-query", "/api/query", query);
      await http.initialize();
      const accepted = await http.send("fairness-background-job", "/mcp", rpc(400, "gno_embed", { collection: "qa-background" }));
      const jobId = (accepted.parsed as any)?.result?.structuredContent?.jobId;
      if (!jobId) throw Error("Fairness background job not accepted");
      const demandAt = Date.now();
      const foreground = await Promise.all(Array.from({ length: 12 }, (_, index) => http.send(`fairness-foreground-${index}`, "/api/query", query)));
      const comparisons = await Promise.all(foreground.map((reply, index) => compareResponses(spec.comparatorRoot, comparisonManifest, `fairness-${index}`, query, idle.parsed, reply.parsed)));
      await save("fairness-comparisons", { demandAt, comparisons });
      await wait(async () => ["completed", "failed", "cancelled"].includes(((await http.send(`fairness-job-${Date.now()}`, `/api/jobs/${jobId}`)).parsed as any)?.status), 120000);
      await stop(run, "fairness-shutdown");
      await save("result", { status: "CAPTURED_PENDING_ACCEPTANCE", scenarioPhase: spec.scenarioPhase, foregroundRequests: 12, exactResponseComparisons: comparisons.map(row => row.comparison), required: "Actual send/receive/ACK queued-background debt analysis; no sampling inference" });
      return;
    }
    if (!String(spec.scenarioPhase ?? "all").startsWith("shutdown-")) {
    if (spec.warmPrimer) {
      // Separate declared cold and primer rows; neither replaces or edits the other.
      await http.send("declared-cold-ask", "/api/ask", ask);
      await http.send("declared-warm-primer", spec.warmPrimer.path, spec.warmPrimer.body);
    }
    const idle = await http.send("idle-query", "/api/query", query);
    const idleAsk = await http.send("idle-ask", "/api/ask", ask);
    // The primary and queued request keep their complete original public inputs.
    await Bun.write(`${run.root}/case.txt`, "queued-primary");
    const queueAt = Date.now(); let primaryDone = false;
    const primary = http.send("queued-primary", "/api/ask", ask).finally(() => { primaryDone = true; });
    await wait(async () => primaryDone || Boolean(await active(run.root, queueAt)));
    if (primaryDone) throw Error("Queued scenario primary settled before admission; no retry");
    await Bun.write(`${run.root}/case.txt`, "queued-disconnect");
    const queuedController = new AbortController();
    const queued = http.send("queued-disconnect", "/api/query", query, queuedController.signal).catch(error => ({ error: String(error) }));
    await wait(async () => primaryDone || (await rows(`${run.root}/owner.jsonl`)).some((row: any) => row.at >= queueAt && row.value.kind === "owners" && row.value.rows.some((owner: any) => owner.externalWaiters > 0 || owner.pending.length > 1)));
    if (primaryDone) throw Error("Queued scenario missed owner contention; no retry");
    queuedController.abort(); await save("queued-caller", await queued); await primary;
    await http.send("queued-recovery", "/api/query", query);
    for (const mode of ["rest-disconnect", "mcp-notification", "mcp-disconnect"] as const) {
      if (mode !== "rest-disconnect") await http.initialize();
      await Bun.write(`${run.root}/case.txt`, mode);
      const controller = new AbortController(), start = Date.now();
      let settled = false;
      const pending = http.send(mode, mode === "rest-disconnect" ? "/api/ask" : "/mcp", mode === "rest-disconnect" ? ask : rpc(100, "gno_ask", spec.mcpAskBody), controller.signal).catch(error => ({ error: String(error) })).finally(() => { settled = true; });
      let phase: any;
      await wait(async () => settled || Boolean(phase = await active(run.root, start)));
      if (settled || !phase) throw Error(`${mode}: active phase missed; no retry`);
      const abortAt = Date.now();
      if (mode === "mcp-notification") await http.send(`${mode}-cancel`, "/mcp", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 100, reason: "owned QA" } });
      // Like an MCP client, retire the cancelled caller locally; a cancellation notification has no call response guarantee.
      controller.abort();
      const result = await pending; const callerSettledAt = Date.now();
      const recovery = await http.send(`${mode}-recovery`, "/api/query", query);
      const phaseRows = await rows(`${run.root}/phases.jsonl`);
      const nativeEnd = phaseRows.find((row: any) => row.pid === phase.pid && row.event.kind === "request-end" && row.event.request?.requestId === phase.event.request?.requestId && row.event.request?.generation === phase.event.request?.generation);
      const ownerRows = (await rows(`${run.root}/owner.jsonl`)).filter((row: any) => row.at >= abortAt && row.value.kind === "owners");
      receipts.push({ mode, phase, abortAt, callerSettledAt, callerCancellationMs: callerSettledAt-abortAt, nativeRequestEndAt: nativeEnd?.at ?? null, nativeRetentionMs: nativeEnd ? nativeEnd.at-abortAt : null, nativeEndMeaning: "dispatcher finally; parent queue settlement samples separate", ownerRows, result });
      await save(`${mode}-equality`, await compareResponses(spec.comparatorRoot, comparisonManifest, mode, query, idle.parsed, recovery.parsed));
    }
    await http.initialize();
    const accepted: any = await http.send("accepted-job", "/mcp", rpc(200, "gno_embed", { collection: "qa-background" }));
    const job = accepted.parsed?.result?.structuredContent?.jobId ?? accepted.parsed?.result?.structuredContent?.data?.jobId;
    if (!job) throw Error("Accepted job ID absent; preserve response, do not infer");
    await http.send("origin-session-close", "/mcp", undefined, undefined, "DELETE");
    const backgroundAt = Date.now();
    const jobBefore = await http.send("job-before-foreground", `/api/jobs/${job}`);
    const background = await http.send("background-query", "/api/query", query);
    const backgroundAsk = await http.send("background-ask", "/api/ask", ask);
    await save("background-comparison", { query: await compareResponses(spec.comparatorRoot, comparisonManifest, "background-query", query, idle.parsed, background.parsed), ask: await compareResponses(spec.comparatorRoot, comparisonManifest, "background-ask", ask, idleAsk.parsed, backgroundAsk.parsed) });
    await http.send("job-after-disconnect", `/api/jobs/${job}`);
    await save("background-overlap", { backgroundAt, jobBefore, note: "Actual overlap requires child request intervals; completed job before foreground is unexercised, never PASS." });
    }
    // A separately pinned shutdown backlog prevents an already-complete job posing as active work.
    const shutdownFiles = [];
    const shutdownCount = spec.shutdownDocumentCount ?? 64;
    if (![64, 1024].includes(shutdownCount)) throw Error("Undeclared shutdown fixture size");
    for (let i = 64; i < 64 + shutdownCount; i++) { const content = `# Synthetic shutdown record ${i}\n\nDurable unfinished archive checkpoint ${i}.\n`; const path = `${backlog}/record-${i}.md`; await Bun.write(path, content); shutdownFiles.push({ path, sha256: hash(content) }); }
    await save("shutdown-backlog-manifest", { files: shutdownFiles });
    const shutdownAt = Date.now();
    const sync: any = await http.send("shutdown-sync", "/api/sync", { collection: "qa-background" });
    await save("shutdown-sync-accepted", sync);
    // Sync itself embeds. Observe that actual work before it completes; do not submit a second empty job.
    await wait(async () => { const events = await rows(`${run.root}/phases.jsonl`); return events.some((row: any) => row.at >= shutdownAt && row.event.kind === "request-start" && ["embed", "embedBatch"].includes(row.event.request?.op) && !events.some((end: any) => end.pid === row.pid && end.event.kind === "request-end" && end.event.request?.requestId === row.event.request?.requestId)); });
    const beforeStop = await coverage("before-shutdown-coverage");
    if (!beforeStop.missing.length) throw Error("Shutdown backlog finished before signal; active unfinished-work branch unexercised");
    await snapshot("before-shutdown"); await stop(run, "shutdown"); await snapshot("after-shutdown");
    const afterStop = await coverage("after-shutdown-coverage");
    await save("shutdown-durable-identities", { expectedPreserved: Bun.deepEquals(beforeStop.expected, afterStop.expected), pendingAtSignal: beforeStop.missing.length, pendingAfterExit: afterStop.missing.length });
    run = await launch("serve"); http = run.wire as HttpWire;
    if (spec.warmPrimer) await http.send("declared-restart-primer", spec.warmPrimer.path, spec.warmPrimer.body);
    await http.send("resume", "/api/embed", {});
    await snapshot("after-resume");
    const resumedCoverage = await coverage("after-resume-coverage");
    if (resumedCoverage.missing.length || resumedCoverage.duplicateKeys) throw Error("Resumed background coverage incomplete or duplicate");
    await http.send("restart-query", "/api/query", query);
    await stop(run, "restart-shutdown");
    if (spec.scenarioPhase === "shutdown-only") {
      await save("result", { status: "CAPTURED_PENDING_ACCEPTANCE", scenarioPhase: spec.scenarioPhase, shutdownDocumentCount: shutdownCount, resumedCoverage: { expected: resumedCoverage.expected.length, completed: resumedCoverage.completed.length, missing: resumedCoverage.missing.length, duplicateKeys: resumedCoverage.duplicateKeys } });
      return;
    }
    const stdioRun = await launch("mcp"); const stdio = stdioRun.wire as StdioWire;
    await stdio.initialize(); const at = Date.now();
    const pending = stdio.send(rpc(300, "gno_ask", spec.mcpAskBody)).catch(error => ({ error: String(error) }));
    await wait(async () => Boolean(await active(stdioRun.root, at)));
    await stdio.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 300, reason: "owned QA" } });
    stdio.retireCaller(300);
    await save("stdio-cancel-result", await pending); stdio.close(); await stop(stdioRun, "stdio-shutdown");
    const disconnectedRun = await launch("mcp"); const disconnected = disconnectedRun.wire as StdioWire;
    await disconnected.initialize(); const disconnectAt = Date.now();
    const disconnectedCall = disconnected.send(rpc(301, "gno_ask", spec.mcpAskBody)).catch(error => ({ error: String(error) }));
    await wait(async () => Boolean(await active(disconnectedRun.root, disconnectAt)));
    disconnected.close(); await save("stdio-disconnect-result", await disconnectedCall); await stop(disconnectedRun, "stdio-disconnect-shutdown");
    if (spec.cliShutdownProbes) {
      // Separate public CLI entry strata, never relabeled factory-observer evidence.
      for (const kind of ["daemon", "serve"] as const) {
        const additions = [];
        for (let i = 0; i < 64; i++) { const path = `${backlog}/cli-${kind}-${i}.md`; const content = `# Synthetic ${kind} shutdown checkpoint ${i}\n\nDurable queued archival record ${kind} ${i}.\n`; await Bun.write(path, content); additions.push({ path, sha256: hash(content) }); }
        await save(`cli-${kind}-fixture`, { files: additions, stratum: kind === "daemon" ? "original default initial-sync enabled" : "actual CLI serve with admitted native work" });
        const started = Date.now(); const cliRun = await launch(kind, true); const publicWire = cliRun.wire as HttpWire;
        let inflight: Promise<unknown> | undefined;
        if (kind === "serve") {
          inflight = publicWire.send("cli-serve-sync", "/api/sync", { collection: "qa-background" }).catch(error => ({ error: String(error) }));
        }
        await wait(async () => { const events = await rows(`${cliRun.root}/phases.jsonl`); return events.some((row: any) => row.at >= started && row.event.kind === "request-start" && ["embed", "embedBatch"].includes(row.event.request?.op) && !events.some((end: any) => end.pid === row.pid && end.event.kind === "request-end" && end.event.request?.requestId === row.event.request?.requestId)); });
        await snapshot(`cli-${kind}-before-signal`); await stop(cliRun, `cli-${kind}-SIGTERM`); await snapshot(`cli-${kind}-after-exit`);
        if (inflight) await save(`cli-${kind}-caller`, await inflight);
      }
    }
    await save("result", { status: "CAPTURED_PENDING_ACCEPTANCE", receipts, requiredFinalChecks: ["fn143 semantic comparator", "queue/fairness/model-specific leases", "durable chunk set equality", "validated descendant absence", "stuck-shutdown branch coverage"] });
  } catch (error) { await save("result", { status: "INCOMPLETE", error: String(error), receipts }); throw error; }
  finally { for (const child of owned) if (child.exitCode === null) child.kill("SIGTERM"); }
}
if (arg[0] === "--preflight") await preflight();
else if (arg[0] === "--config" && arg[1]) await main(arg[1]);
else throw Error("Usage: bun notes/fn146.5-run.ts --preflight | --config run.json --native");
