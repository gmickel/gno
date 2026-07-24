import { describe, expect, test } from "bun:test";
import { join } from "node:path";
// Bun has no path join helper.

const manifestPath = join(import.meta.dir, "..", "manifest.json");

describe("browser clipper manifest", () => {
  test("uses only explicit-action and trusted local storage permissions", async () => {
    const manifest = await Bun.file(manifestPath).json();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBeUndefined();
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.background.service_worker).toBe("service-worker.js");
    expect(manifest.action.default_popup).toBe("preview.html");
    expect(JSON.stringify(manifest)).not.toMatch(
      /history|cookies|<all_urls>|webRequest|externally_connectable/u
    );

    const serviceWorker = await Bun.file(
      join(import.meta.dir, "..", "src", "service-worker.ts")
    ).text();
    const contentScript = await Bun.file(
      join(import.meta.dir, "..", "src", "content.ts")
    ).text();
    expect(serviceWorker).toContain('accessLevel: "TRUSTED_CONTEXTS"');
    expect(serviceWorker).not.toContain("storage.sync");
    expect(contentScript).not.toMatch(/storage|gateway|grantToken/u);
  });
});
