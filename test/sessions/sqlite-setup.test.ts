import { expect, test } from "bun:test";

// macOS needs Database.setCustomSQLite before the first Database opens; a
// session module that opens one first (the CLI binding check runs before
// every command) would leave every later index open without extensions.
test("every session module that opens a Database configures SQLite first", async () => {
  const glob = new Bun.Glob("**/*.ts");
  const offenders: string[] = [];
  for await (const path of glob.scan({ cwd: "src/sessions" })) {
    const source = await Bun.file(`src/sessions/${path}`).text();
    if (!source.includes("new Database(")) continue;
    const setupImport = source.indexOf('store/sqlite/setup";');
    const firstOpen = source.indexOf("new Database(");
    if (setupImport === -1 || setupImport > firstOpen) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
