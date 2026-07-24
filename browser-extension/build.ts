// node:fs/promises supplies atomic directory renames and structure operations.
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { replaceDirectory } from "./filesystem";

interface PackageManifest {
  version: string;
}

interface ExtensionManifest {
  manifest_version: number;
  name: string;
  description: string;
  permissions: string[];
  host_permissions: string[];
  background: Record<string, unknown>;
  action: Record<string, unknown>;
  content_security_policy: Record<string, unknown>;
}

export interface BuildClipperOptions {
  outdir?: string;
  rootDir?: string;
}

const buildEntrypoints = async (
  entrypoints: string[],
  outdir: string,
  format: "esm" | "iife" = "esm"
): Promise<void> => {
  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "browser",
    format,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
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

const assertManifestVersion = (version: string): void => {
  const components = version.split(".");
  if (
    components.length < 1 ||
    components.length > 4 ||
    components.some(
      (component) =>
        !/^(?:0|[1-9]\d*)$/u.test(component) || Number(component) > 65_535
    )
  ) {
    throw new Error(
      `Package version ${version} is not a Chromium manifest version`
    );
  }
};

export const buildClipper = async (
  options: BuildClipperOptions = {}
): Promise<string> => {
  const root = resolve(options.rootDir ?? import.meta.dir);
  const outdir = resolve(options.outdir ?? join(root, "dist"));
  const temporary = join(
    dirname(outdir),
    `.${basename(outdir)}-build-${process.pid}`
  );
  await rm(temporary, { force: true, recursive: true });
  await mkdir(temporary, { recursive: true });
  try {
    await buildEntrypoints([join(root, "src", "preview.html")], temporary);
    await buildEntrypoints([join(root, "src", "service-worker.ts")], temporary);
    await buildEntrypoints(
      [join(root, "src", "content.ts")],
      temporary,
      "iife"
    );

    const packageManifest = (await Bun.file(
      join(root, "..", "package.json")
    ).json()) as PackageManifest;
    assertManifestVersion(packageManifest.version);
    const manifestTemplate = (await Bun.file(
      join(root, "manifest.json")
    ).json()) as ExtensionManifest;
    await Bun.write(
      join(temporary, "manifest.json"),
      `${JSON.stringify(
        { ...manifestTemplate, version: packageManifest.version },
        null,
        2
      )}\n`
    );
    await Bun.write(
      join(temporary, "PRIVACY.md"),
      Bun.file(join(root, "PRIVACY.md"))
    );
    await replaceDirectory(temporary, outdir);
    return outdir;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
};
