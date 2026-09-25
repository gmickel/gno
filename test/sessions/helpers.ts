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

/**
 * Write synthetic Codex rollouts (placeholder text only) for load tests:
 * `threads` files of `turns` human/assistant turn pairs.
 */
export async function writeSyntheticCodexRollouts(
  dir: string,
  threads: number,
  turns: number
): Promise<void> {
  const filler =
    "Placeholder discussion about an example component and its trade-offs. ".repeat(
      6
    );
  for (let thread = 0; thread < threads; thread += 1) {
    const id = `0000bulk-0000-7000-8000-${String(thread).padStart(12, "0")}`;
    const at = (second: number): string =>
      new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();
    const item = (turn: number, second: number, value: unknown): string =>
      JSON.stringify({
        timestamp: at(second),
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: id,
          turn_id: `turn-${turn}`,
          item: value,
        },
      });
    const lines = [
      JSON.stringify({
        timestamp: at(0),
        type: "session_meta",
        payload: {
          id,
          session_id: id,
          timestamp: at(0),
          cwd: "/work/example",
          originator: "codex-tui",
          cli_version: "0.156.1",
          source: "cli",
          thread_source: "user",
          model_provider: "openai",
        },
      }),
    ];
    for (let turn = 0; turn < turns; turn += 1) {
      lines.push(
        item(turn, turn * 2 + 1, {
          type: "UserMessage",
          id: `u-${turn}`,
          content: [
            {
              type: "text",
              text: `Question ${turn}. ${filler}`,
              text_elements: [],
            },
          ],
        }),
        item(turn, turn * 2 + 2, {
          type: "AgentMessage",
          id: `a-${turn}`,
          phase: "final_answer",
          content: [{ type: "Text", text: `Answer ${turn}. ${filler}` }],
        })
      );
    }
    await Bun.write(
      join(dir, `rollout-2026-09-01T00-00-00-${id}.jsonl`),
      `${lines.join("\n")}\n`
    );
  }
}
