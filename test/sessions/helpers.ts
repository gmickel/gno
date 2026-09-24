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

/** Environment keys the session tests redirect to temp directories. */
const SESSION_TEST_ENV_KEYS = [
  "GNO_CONFIG_DIR",
  "GNO_DATA_DIR",
  "GNO_CACHE_DIR",
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "HERMES_HOME",
] as const;

/**
 * Snapshot the session-related environment. `restore()` deletes keys that
 * were unset (assigning `undefined` would store the string "undefined" and
 * leak into later test files in the same process).
 */
export function snapshotSessionEnv(): () => void {
  const saved = new Map(
    SESSION_TEST_ENV_KEYS.map((key) => [key, process.env[key]] as const)
  );
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
