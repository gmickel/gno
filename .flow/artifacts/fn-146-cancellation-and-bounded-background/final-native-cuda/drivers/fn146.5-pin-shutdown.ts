/** AST/source fingerprints only: does not import product or execute shutdown/native code. */
import ts from "typescript";
const root = Bun.argv[2] ?? process.cwd();
const output = Bun.argv[3] ?? `${import.meta.dir}/fn146.5-shutdown-source-pins.json`;
const selected: Record<string, string[]> = {
  "src/store/sqlite/adapter.ts": ["beginShutdown", "fenceForShutdown", "close"],
  "src/serve/resident-admission.ts": ["stop", "drain", "cancel"],
  "src/serve/resident-background-work.ts": ["drain", "cancel"],
  "src/core/job-manager.ts": ["stop", "shutdown", "cancel", "failUnfinished"],
  "src/llm/nodeLlamaCpp/adapter.ts": ["dispose"],
  "src/llm/native-worker/client.ts": ["dispose", "retire"],
  "src/serve/resident-shutdown.ts": ["disposeResidentResources"],
  "src/core/shutdown-budget.ts": ["settlesBy", "shutdownDuration"],
  "src/llm/native-worker/owned-exit.ts": ["exitOwnedChild", "retireOwnedChild"],
  "src/serve/resident-runtime.ts": ["dispose"],
  "src/serve/embed-scheduler.ts": ["stop", "dispose"],
};
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const files = [];
for (const [path, names] of Object.entries(selected)) {
  const source = await Bun.file(`${root}/${path}`).text();
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: unknown[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && names.includes(node.name.getText(tree))) methods.push({ name: node.name.getText(tree), line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, sourceDeclarationSha256: hash(node.getText(tree)) });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  files.push({ path, sha256: hash(source), methods });
}
await Bun.write(output, JSON.stringify({ scope: "draft read-only source/AST pins; regenerate after final freeze", root, recordedAt: new Date().toISOString(), nativeExecuted: false, productImported: false, runtimeFunctionHashes: "Captured separately by shutdown observer at actual installation", files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, declarations: files.reduce((n, row) => n + row.methods.length, 0), native: false }));
