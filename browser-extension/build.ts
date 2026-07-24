import { cp, mkdir, rm } from "node:fs/promises";
// Bun has no directory-tree copy/remove API.
import { join } from "node:path";

const root = import.meta.dir;
const outdir = join(root, "dist");
await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });

const build = async (
  entrypoints: string[],
  format: "esm" | "iife" = "esm"
): Promise<void> => {
  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "browser",
    format,
    minify: true,
    sourcemap: "none",
    splitting: false,
    naming: "[name].[ext]",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Browser clipper build failed");
  }
};

await build([join(root, "src", "preview.html")]);
await build([join(root, "src", "service-worker.ts")]);
await build([join(root, "src", "content.ts")], "iife");
await cp(join(root, "manifest.json"), join(outdir, "manifest.json"));
