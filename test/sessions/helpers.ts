import { Database } from "bun:sqlite";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/mkdir)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

export const FIXTURES = join(import.meta.dir, "../fixtures/sessions");

/** Fake credentials planted in the fixtures; none may survive persistence. */
export const FIXTURE_SECRETS = [
  "sk-proj-GNOFIXTUREabcdefghijklmnopqrstuvwx",
  "GnoFixtureSecret123",
  "GnoFixtureBearerToken0123456789",
] as const;

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Materialize the SQL fixtures as databases in the harness layouts. */
export async function buildSqliteFixtures(root: string): Promise<{
  openclawRoot: string;
  openclawDb: string;
  hermesRoot: string;
  hermesDb: string;
}> {
  const openclawRoot = join(root, "openclaw");
  const agentDir = join(openclawRoot, "agents", "main", "agent");
  const hermesRoot = join(root, "hermes");
  await mkdir(agentDir, { recursive: true });
  await mkdir(hermesRoot, { recursive: true });
  const openclawDb = join(agentDir, "openclaw-agent.sqlite");
  const hermesDb = join(hermesRoot, "state.db");
  const oc = new Database(openclawDb, { create: true });
  oc.exec(
    await Bun.file(join(FIXTURES, "sql/openclaw-agent-v2026.9.6.sql")).text()
  );
  oc.close();
  const hermes = new Database(hermesDb, { create: true });
  hermes.exec(
    await Bun.file(join(FIXTURES, "sql/hermes-state-v0.19.sql")).text()
  );
  hermes.close();
  return { openclawRoot, openclawDb, hermesRoot, hermesDb };
}
