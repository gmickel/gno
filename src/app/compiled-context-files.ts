// Bun has no lstat, exclusive-create, hard-link or atomic-rename primitives.
import { lstat, open, link, rename, unlink } from "node:fs/promises";
import { dirname, parse, resolve, join } from "node:path";
import { z } from "zod";

import type {
  CompiledContextCheck,
  CompiledContextPreview,
} from "../core/compiled-context";
import type { ContextCapsuleV1 } from "../core/context-capsule";
import type { ContextCapsuleBuildInput } from "./context-runtime";

import { withWriteLock } from "../core/file-lock";
import {
  checkCompiledContext,
  compiledContextRefreshRequest,
  previewCompiledContext,
  type CompiledContextRuntimeDeps,
} from "./compiled-context";

const MAX_BYTES = 4 * 1024 * 1024;
const snapshotSchema = z
  .object({
    capsulePath: z.string().min(1),
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    settings: z
      .object({
        budgetTokens: z.number().int().positive(),
        budgetBytes: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
const sidecarSchema = snapshotSchema
  .extend({
    artifactKind: z.literal("gno_compiled_context_sidecar"),
    schemaVersion: z.literal("1.0"),
    rendererVersion: z.literal("1"),
    previous: snapshotSchema.optional(),
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;
type Sidecar = z.infer<typeof sidecarSchema>;
export interface CompiledContextFileResult {
  status: "written" | "unchanged";
  outputPath: string;
  capsulePath: string;
  sidecarPath: string;
  preview: CompiledContextPreview;
}
const digest = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const isMissing = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

/** Refuse links in every existing path component; never create parent directories. */
async function safePath(path: string, allowMissing = false): Promise<string> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
      ) {
        throw new Error(`Unsafe compiled-context path: ${current}`);
      }
    } catch (error) {
      if (allowMissing && index === parts.length - 1 && isMissing(error))
        return absolute;
      throw error;
    }
  }
  return absolute;
}
async function readBounded(path: string): Promise<string> {
  await safePath(path);
  const file = Bun.file(path);
  if (file.size > MAX_BYTES)
    throw new Error("Compiled-context input exceeds 4 MiB");
  return file.text();
}
async function absent(path: string): Promise<void> {
  await safePath(path, true);
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Destination already exists: ${path}`);
}
function outputTarget(path: string): string {
  if (!path.endsWith(".gno-context.md"))
    throw new Error("Output must end in .gno-context.md");
  return resolve(path);
}
async function stage(path: string, content: string): Promise<string> {
  await safePath(path, true);
  const temp = join(dirname(path), `.${crypto.randomUUID()}.gno-context.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await Bun.write(Bun.file(handle.fd), content);
    await handle.sync();
  } catch (error) {
    await unlink(temp);
    throw error;
  } finally {
    await handle.close();
  }
  return temp;
}
async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
function sidecar(snapshot: Snapshot, previous?: Snapshot): Sidecar {
  return {
    artifactKind: "gno_compiled_context_sidecar",
    schemaVersion: "1.0",
    rendererVersion: "1",
    ...snapshot,
    ...(previous ? { previous } : {}),
  };
}
async function owned(
  outputPath: string
): Promise<{ markdown: string; snapshot: Snapshot; sidecarText: string }> {
  const markdown = await readBounded(outputPath);
  const sidecarText = await readBounded(`${outputPath}.json`);
  const metadata = sidecarSchema.parse(JSON.parse(sidecarText));
  const outputDigest = digest(markdown);
  const snapshot =
    metadata.outputDigest === outputDigest
      ? snapshotSchema.parse({
          capsulePath: metadata.capsulePath,
          outputDigest: metadata.outputDigest,
          settings: metadata.settings,
        })
      : metadata.previous;
  if (!snapshot || snapshot.outputDigest !== outputDigest)
    throw new Error("Conflict: compiled context was manually changed");
  return { markdown, snapshot, sidecarText };
}
async function unchanged(
  outputPath: string,
  original: Awaited<ReturnType<typeof owned>>
): Promise<void> {
  if (
    (await readBounded(outputPath)) !== original.markdown ||
    (await readBounded(`${outputPath}.json`)) !== original.sidecarText
  ) {
    throw new Error("Conflict: compiled context changed during publication");
  }
}
function result(
  outputPath: string,
  capsulePath: string,
  preview: CompiledContextPreview,
  status: "written" | "unchanged"
): CompiledContextFileResult {
  return {
    status,
    outputPath,
    capsulePath,
    sidecarPath: `${outputPath}.json`,
    preview,
  };
}

export async function compileContextFile(
  input: {
    capsulePath: string;
    outputPath: string;
    budgetTokens: number;
    budgetBytes?: number;
  },
  deps: CompiledContextRuntimeDeps
): Promise<CompiledContextFileResult> {
  const outputPath = outputTarget(input.outputPath);
  const capsulePath = await safePath(input.capsulePath);
  await absent(outputPath);
  await absent(`${outputPath}.json`);
  await safePath(`${outputPath}.lock`, true);
  return withWriteLock(`${outputPath}.lock`, async () => {
    await absent(outputPath);
    await absent(`${outputPath}.json`);
    const capsuleText = await readBounded(capsulePath);
    const capsule = JSON.parse(capsuleText);
    const settings = {
      budgetTokens: input.budgetTokens,
      ...(input.budgetBytes === undefined
        ? {}
        : { budgetBytes: input.budgetBytes }),
    };
    const preview = await previewCompiledContext(
      { capsule, ...settings },
      deps
    );
    const metadata = sidecar({
      capsulePath,
      outputDigest: preview.digest,
      settings,
    });
    const stagedOutput = await stage(outputPath, preview.markdown);
    let stagedSidecar: string | undefined;
    let publishedSidecar = false;
    try {
      stagedSidecar = await stage(
        `${outputPath}.json`,
        JSON.stringify(metadata)
      );
      const checked = await checkCompiledContext(
        { capsule, markdown: preview.markdown },
        deps
      );
      if (
        checked.status !== "current" ||
        (await readBounded(capsulePath)) !== capsuleText
      )
        throw new Error("Source or policy changed before publication");
      await absent(outputPath);
      await absent(`${outputPath}.json`);
      await link(stagedSidecar, `${outputPath}.json`);
      publishedSidecar = true;
      await link(stagedOutput, outputPath);
      return result(outputPath, capsulePath, preview, "written");
    } catch (error) {
      if (publishedSidecar) await removeTemp(`${outputPath}.json`);
      throw error;
    } finally {
      await removeTemp(stagedOutput);
      if (stagedSidecar) await removeTemp(stagedSidecar);
    }
  });
}

export async function checkContextFile(
  input: { outputPath: string; capsulePath?: string },
  deps: CompiledContextRuntimeDeps
): Promise<CompiledContextCheck> {
  try {
    const outputPath = outputTarget(input.outputPath);
    const saved = await owned(outputPath);
    const capsule = JSON.parse(
      await readBounded(input.capsulePath ?? saved.snapshot.capsulePath)
    );
    return await checkCompiledContext(
      { capsule, markdown: saved.markdown },
      deps
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unavailable compiled context";
    return {
      schemaVersion: "1.0",
      status: message.startsWith("Conflict:") ? "conflict" : "unverifiable",
      reasons: [message],
      digest: null,
      capsuleId: null,
    };
  }
}

export async function refreshContextFile(
  input: { outputPath: string; capsuleOutputPath: string },
  deps: CompiledContextRuntimeDeps,
  build: (request: ContextCapsuleBuildInput) => Promise<ContextCapsuleV1>
): Promise<CompiledContextFileResult> {
  const outputPath = outputTarget(input.outputPath);
  if (!input.capsuleOutputPath.endsWith(".gno-context.capsule.json"))
    throw new Error("Refreshed Capsule must end in .gno-context.capsule.json");
  const capsulePath = await safePath(input.capsuleOutputPath, true);
  await safePath(`${outputPath}.lock`, true);
  return withWriteLock(`${outputPath}.lock`, async () => {
    const saved = await owned(outputPath);
    const priorCapsuleText = await readBounded(saved.snapshot.capsulePath);
    const priorCapsule = JSON.parse(priorCapsuleText);
    const current = await checkCompiledContext(
      { capsule: priorCapsule, markdown: saved.markdown },
      deps
    );
    if (current.status === "current") {
      const preview = await previewCompiledContext(
        { capsule: priorCapsule, ...saved.snapshot.settings },
        deps
      );
      await unchanged(outputPath, saved);
      if ((await readBounded(saved.snapshot.capsulePath)) !== priorCapsuleText)
        throw new Error("Capsule changed during refresh");
      return result(
        outputPath,
        saved.snapshot.capsulePath,
        preview,
        "unchanged"
      );
    }
    if (current.status !== "stale")
      throw new Error(
        `Cannot refresh ${current.status} context: ${current.reasons.join("; ")}`
      );
    await absent(capsulePath);
    // Stage first so an unwritable Capsule destination fails before retrieval/publication.
    const stagedCapsule = await stage(capsulePath, "");
    let stagedOutput: string | undefined;
    let stagedSidecar: string | undefined;
    try {
      const capsule = await build(
        compiledContextRefreshRequest(priorCapsule, deps)
      );
      const preview = await previewCompiledContext(
        { capsule, ...saved.snapshot.settings },
        deps
      );
      await Bun.write(stagedCapsule, JSON.stringify(capsule));
      stagedOutput = await stage(outputPath, preview.markdown);
      stagedSidecar = await stage(
        `${outputPath}.json`,
        JSON.stringify(
          sidecar(
            {
              capsulePath,
              outputDigest: preview.digest,
              settings: saved.snapshot.settings,
            },
            saved.snapshot
          )
        )
      );
      const checked = await checkCompiledContext(
        { capsule, markdown: preview.markdown },
        deps
      );
      if (checked.status !== "current")
        throw new Error("Source or policy changed before publication");
      await unchanged(outputPath, saved);
      if ((await readBounded(saved.snapshot.capsulePath)) !== priorCapsuleText)
        throw new Error("Capsule changed during refresh");
      await absent(capsulePath);
      await link(stagedCapsule, capsulePath);
      // Retain one prior reference: either output remains verifiable after interruption.
      await rename(stagedSidecar, `${outputPath}.json`);
      await rename(stagedOutput, outputPath);
      return result(outputPath, capsulePath, preview, "written");
    } finally {
      await removeTemp(stagedCapsule);
      if (stagedOutput) await removeTemp(stagedOutput);
      if (stagedSidecar) await removeTemp(stagedSidecar);
    }
  });
}
