import type { Subprocess } from "bun";

/** Retained per-snapshot SDK process; payloads are lossless compressed files. */
// Bun has no mkdir/mkdtemp/realpath filesystem structure equivalents.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
// Bun has no path construction utilities.
import { join } from "node:path";

import type { AcceptanceManifest } from "./manifest";
import type {
  AdapterRequest,
  AdapterResult,
  NativeAcceptanceInit,
} from "./native-adapter";
import type { OwnedResources } from "./resources";
import type { AcceptanceSession, AcceptanceSessionFactory } from "./runner";

import {
  assertPackageSmokePathContained,
  buildPackageSmokeProcessEnv,
} from "../../scripts/package-smoke-isolation";

export interface SessionBootstrap {
  runId: string;
  directory: string;
  manifest: AcceptanceManifest;
  init: NativeAcceptanceInit;
  requests: AdapterRequest[];
}
export interface SessionCommand {
  runId: string;
  sequence: number;
  operation: "run" | "state" | "close";
  caseId?: string;
}
interface Message {
  runId: string;
  pid: number;
  ready?: boolean;
  ok: boolean;
  sequence?: number;
  resultPath?: string;
  error?: string;
  startedAt?: string;
  preflightMs?: number;
}
export interface SessionDriverSession extends AcceptanceSession {
  processIdentity: {
    pid: number;
    runId: string;
    sourceRoot: string;
    startedAt?: string;
    directory: string;
    preflightMs?: number;
  };
  idle(ms: number): Promise<void>;
}
export interface SessionDriverFactory extends AcceptanceSessionFactory {
  open(scope: OwnedResources): Promise<SessionDriverSession>;
}

export interface SessionDriverOptions {
  sourceRoot: string;
  isolatedRoot: string;
  protocolRoot: string;
  manifest: AcceptanceManifest;
  init: NativeAcceptanceInit;
  requests: AdapterRequest[];
  timeoutMs?: number;
}

/** Install only the development harness into a preselected archived source tree.
 * Existing differing files are refused. Product files are never copied. */
export async function installSessionHarness(sourceRoot: string): Promise<void> {
  const target = join(await realpath(sourceRoot), "evals/acceptance");
  await mkdir(target, { recursive: true });
  if ((await realpath(target)) === (await realpath(import.meta.dir))) return;
  for (const name of [
    "session-child.ts",
    "native-adapter.ts",
    "native-capture.ts",
    "manifest.ts",
    "records.ts",
  ]) {
    const bytes = await Bun.file(join(import.meta.dir, name)).arrayBuffer();
    const destination = Bun.file(join(target, name));
    if (await destination.exists()) {
      const existing = await destination.arrayBuffer();
      if (Buffer.compare(Buffer.from(existing), Buffer.from(bytes)) !== 0)
        throw new Error(`Snapshot harness differs: ${name}`);
    } else await Bun.write(destination, bytes);
  }
}

export function createSessionDriverFactory(
  options: SessionDriverOptions
): SessionDriverFactory {
  return {
    async open(scope) {
      const sourceRoot = await realpath(options.sourceRoot);
      await assertPackageSmokePathContained(
        options.isolatedRoot,
        options.init.dbPath,
        "acceptance DB"
      );
      for (const collection of options.init.config.collections)
        await assertPackageSmokePathContained(
          options.isolatedRoot,
          collection.path,
          "acceptance corpus"
        );
      await assertPackageSmokePathContained(
        options.isolatedRoot,
        options.protocolRoot,
        "acceptance protocol"
      );
      await mkdir(options.protocolRoot, { recursive: true });
      const directory = await mkdtemp(join(options.protocolRoot, "session-"));
      const runId = crypto.randomUUID();
      const env: Record<string, string> = { GNO_NO_AUTO_DOWNLOAD: "1" };
      for (const [key, name] of Object.entries({
        HOME: "home",
        XDG_CONFIG_HOME: "config",
        XDG_DATA_HOME: "data",
        XDG_CACHE_HOME: "cache",
        XDG_STATE_HOME: "state",
        GNO_CONFIG_DIR: "config/gno",
        GNO_DATA_DIR: "data/gno",
        GNO_CACHE_DIR: "cache/gno",
        GNO_SKILLS_HOME_OVERRIDE: "skills/home",
        CLAUDE_SKILLS_DIR: "skills/claude",
        CODEX_SKILLS_DIR: "skills/codex",
        OPENCODE_SKILLS_DIR: "skills/opencode",
        OPENCLAW_SKILLS_DIR: "skills/openclaw",
        HERMES_SKILLS_DIR: "skills/hermes",
        APPDATA: "appdata",
        LOCALAPPDATA: "localappdata",
        USERPROFILE: "home",
        TEMP: "tmp",
        TMP: "tmp",
        TMPDIR: "tmp",
        npm_config_cache: "npm/cache",
        npm_config_prefix: "npm/prefix",
        npm_config_userconfig: "npm/config",
      })) {
        env[key] = join(directory, name);
        await mkdir(env[key], { recursive: true });
      }
      const safeEnv = await buildPackageSmokeProcessEnv(directory, env);
      const configPath = join(directory, "bootstrap.json");
      await Bun.write(
        configPath,
        JSON.stringify({
          runId,
          directory,
          manifest: options.manifest,
          init: options.init,
          requests: options.requests,
        } satisfies SessionBootstrap)
      );
      const timeoutMs = options.timeoutMs ?? 120000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Invalid session timeout");
      const pending = new Map<
        number,
        {
          resolve: (message: Message) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      let child: Subprocess;
      let readyResolve: (message: Message) => void = () => {};
      let readyReject: (error: Error) => void = () => {};
      const ready = new Promise<Message>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      let sequence = 0;
      let closed = false;
      let busy = false;
      const rejectAll = (error: Error) => {
        readyReject(error);
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(error);
        }
        pending.clear();
      };
      const onMessage = (value: unknown) => {
        const message = value as Message;
        if (message?.runId !== runId || message.pid !== child.pid) {
          rejectAll(new Error("Session reply identity mismatch"));
          child.kill("SIGKILL");
          return;
        }
        if (message.ready) {
          if (message.ok) readyResolve(message);
          else
            readyReject(new Error(message.error ?? "Session startup failed"));
          return;
        }
        const item =
          message.sequence === undefined
            ? undefined
            : pending.get(message.sequence);
        if (!item) {
          rejectAll(new Error("Unexpected session reply sequence"));
          child.kill("SIGKILL");
          return;
        }
        clearTimeout(item.timer);
        pending.delete(message.sequence!);
        if (message.ok) item.resolve(message);
        else item.reject(new Error(message.error ?? "Session request failed"));
      };
      child = Bun.spawn(
        [
          process.execPath,
          join(sourceRoot, "evals/acceptance/session-child.ts"),
        ],
        {
          cwd: sourceRoot,
          env: { ...safeEnv, GNO_ACCEPTANCE_SESSION_CONFIG: configPath },
          stdout: Bun.file(join(directory, "stdout.log")),
          stderr: Bun.file(join(directory, "stderr.log")),
          ipc: onMessage,
        }
      );
      try {
        scope.own(child);
      } catch (error) {
        await child.exited;
        throw error;
      }
      void child.exited.then((code) =>
        rejectAll(new Error(`Session process exited (${code})`))
      );
      const readyTimer = setTimeout(() => {
        rejectAll(new Error("Session startup timed out"));
        child.kill("SIGKILL");
      }, timeoutMs);
      let readiness: Message;
      try {
        readiness = await ready;
        await Bun.write(
          join(directory, "readiness.json"),
          JSON.stringify(readiness)
        );
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await child.exited;
        throw error;
      } finally {
        clearTimeout(readyTimer);
      }
      async function command(
        operation: SessionCommand["operation"],
        caseId?: string
      ): Promise<unknown> {
        if (
          closed ||
          busy ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          throw new Error("Session closed or busy");
        busy = true;
        sequence += 1;
        try {
          const reply = await new Promise<Message>((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(sequence);
              reject(new Error("Session request timed out"));
              child.kill("SIGKILL");
            }, timeoutMs);
            pending.set(sequence, { resolve, reject, timer });
            try {
              child.send({
                runId,
                sequence,
                operation,
                caseId,
              } satisfies SessionCommand);
            } catch (error) {
              clearTimeout(timer);
              pending.delete(sequence);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
          const expected = join(directory, `${sequence}.reply.json.gz`);
          if (reply.resultPath !== expected)
            throw new Error("Session reply path mismatch");
          const decoded = JSON.parse(
            new TextDecoder().decode(
              Bun.gunzipSync(await Bun.file(expected).arrayBuffer())
            )
          );
          if (
            decoded.runId !== runId ||
            decoded.sequence !== sequence ||
            decoded.pid !== child.pid
          )
            throw new Error("Session payload identity mismatch");
          return decoded.response;
        } catch (error) {
          closed = true;
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          await child.exited;
          throw error;
        } finally {
          busy = false;
        }
      }
      return {
        processId: child.pid,
        processIdentity: {
          pid: child.pid,
          runId,
          sourceRoot,
          startedAt: readiness.startedAt,
          directory,
          preflightMs: readiness.preflightMs,
        },
        async modelState() {
          const state = (await command("state")) as { loaded: boolean | null };
          return state.loaded;
        },
        async run(caseId: string) {
          const response = (await command("run", caseId)) as {
            result: AdapterResult;
          };
          return {
            record: response.result.record,
            coverage: response.result.coverage,
            reasons: response.result.reasons,
          };
        },
        async idle(ms: number) {
          if (!Number.isFinite(ms) || ms < 0)
            throw new Error("Invalid idle duration");
          await Bun.sleep(ms);
        },
        async close() {
          if (closed) return;
          try {
            await command("close");
            await child.exited;
          } finally {
            closed = true;
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
            await child.exited;
          }
        },
      };
    },
  };
}
