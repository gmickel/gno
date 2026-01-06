#!/usr/bin/env bun
/**
 * Asset sync script for GNO website
 *
 * Handles:
 * 1. OG image generation (HTML → PNG via Playwright)
 * 2. Screenshot sync (assets/screenshots/ → website/assets/screenshots/)
 * 3. README hero image (og-template.png → assets/og-image.png)
 *
 * Usage:
 *   bun scripts/sync-assets.ts           # Run all
 *   bun scripts/sync-assets.ts --og      # OG images only
 *   bun scripts/sync-assets.ts --screenshots  # Screenshots only
 *   bun scripts/sync-assets.ts --hero    # README hero only
 */

import { $ } from "bun";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dir, "..");
const ASSETS = join(ROOT, "assets");
const WEBSITE_ASSETS = join(ROOT, "website/assets");
const OG_DIR = join(WEBSITE_ASSETS, "images/og");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    og: { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
    hero: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`
Asset sync script for GNO website

Usage:
  bun scripts/sync-assets.ts           # Run all
  bun scripts/sync-assets.ts --og      # OG images only
  bun scripts/sync-assets.ts --screenshots  # Screenshots only
  bun scripts/sync-assets.ts --hero    # README hero only
`);
  process.exit(0);
}

// If no flags, run all
const runAll = !values.og && !values.screenshots && !values.hero;

async function syncOgImages(): Promise<void> {
  console.log("\n📸 Generating OG images...");
  const result = await $`bun scripts/og-screenshots.ts`.nothrow();
  if (result.exitCode !== 0) {
    console.error(result.stderr.toString());
    throw new Error("OG image generation failed");
  }
  console.log("✓ OG images generated");
}

async function syncScreenshots(): Promise<void> {
  console.log("\n🖼️  Syncing screenshots...");

  const src = join(ASSETS, "screenshots");
  const dest = join(WEBSITE_ASSETS, "screenshots");

  // Ensure dest exists
  await $`mkdir -p ${dest}`.quiet();

  // Copy all screenshots (skip .DS_Store)
  const files = await Array.fromAsync(
    new Bun.Glob("*.{jpg,png,gif}").scan(src)
  );

  let copied = 0;
  for (const file of files) {
    const srcPath = join(src, file);
    const destPath = join(dest, file);

    // Check if needs update (newer or missing)
    const srcFile = Bun.file(srcPath);
    const destFile = Bun.file(destPath);

    const srcStat = await srcFile.exists();
    const destStat = await destFile.exists();

    if (!srcStat) continue;

    let needsCopy = !destStat;
    if (!needsCopy && destStat) {
      // Compare mtimes - Bun.file doesn't expose mtime, use stat
      const srcMtime = (await Bun.file(srcPath).stat()).mtime;
      const destMtime = (await Bun.file(destPath).stat()).mtime;
      needsCopy = srcMtime > destMtime;
    }

    if (needsCopy) {
      await Bun.write(destPath, srcFile);
      copied++;
    }
  }

  console.log(
    `✓ Screenshots synced (${copied} updated, ${files.length} total)`
  );
}

async function syncHeroImage(): Promise<void> {
  console.log("\n🎨 Syncing README hero image...");

  const src = join(OG_DIR, "og-template.png");
  const dest = join(ASSETS, "og-image.png");

  const srcFile = Bun.file(src);
  if (!(await srcFile.exists())) {
    console.log("⚠️  og-template.png not found, run --og first");
    return;
  }

  await Bun.write(dest, srcFile);
  console.log("✓ README hero image synced");
}

async function main(): Promise<void> {
  console.log("🔄 GNO Asset Sync");

  if (runAll || values.og) {
    await syncOgImages();
  }

  if (runAll || values.screenshots) {
    await syncScreenshots();
  }

  if (runAll || values.hero) {
    await syncHeroImage();
  }

  console.log("\n✅ Done");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
