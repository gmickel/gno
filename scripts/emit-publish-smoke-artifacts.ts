/**
 * Emit real GNO producer publish artifacts for gno.sh smoke:publish:gno.
 *
 * Usage:
 *   bun scripts/emit-publish-smoke-artifacts.ts --out <dir>
 *
 * Writes: public-raster.json, secret-raster.json, encrypted-raster.json,
 * legacy-asset-free.json, and manifest.json (passphrase + digests).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises"; // structural ops — no Bun equivalent
import { tmpdir } from "node:os"; // no Bun equivalent
import { join } from "node:path"; // no Bun path utils

import type { Collection } from "../src/config/types";
import type { PublishArtifact } from "../src/publish/artifact";
import type { DocumentRow, StorePort, TagRow } from "../src/store/types";

import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  measureArtifactUploadBytes,
  serializePublishArtifact,
  validatePublishAssetContract,
} from "../src/publish/artifact-assets";
import { exportPublishArtifact } from "../src/publish/export-service";
import { ok } from "../src/store/types";

const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

const PASSPHRASE = "gno-smoke-publish-passphrase-v1";
const MARKER = "GNO-SMOKE-RASTER-MARKER";

const parseOutDir = (argv: string[]): string => {
  const idx = argv.indexOf("--out");
  const value = idx >= 0 ? argv[idx + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(
      "Usage: bun scripts/emit-publish-smoke-artifacts.ts --out <dir>"
    );
  }
  return value;
};

const buildDocument = (
  overrides: Partial<DocumentRow> & Pick<DocumentRow, "id" | "relPath">
): DocumentRow => ({
  active: true,
  collection: "smoke",
  converterId: "markdown",
  converterVersion: "1",
  createdAt: "2026-08-03T12:00:00.000Z",
  docid: `#${overrides.id.toString().padStart(8, "0")}`,
  ingestVersion: 1,
  languageHint: "en",
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  mirrorHash: overrides.id.toString().repeat(64).slice(0, 64),
  sourceExt: ".md",
  sourceHash: (overrides.id + 2).toString().repeat(64).slice(0, 64),
  sourceMime: "text/markdown",
  sourceMtime: "2026-08-03T12:00:00.000Z",
  sourceSize: 100,
  title: null,
  updatedAt: "2026-08-03T12:00:00.000Z",
  uri: `gno://smoke/${overrides.relPath}`,
  ...overrides,
});

const buildStore = (published: DocumentRow, markdown: string): StorePort => {
  const content = new Map([[published.mirrorHash!, markdown]]);
  const tags = new Map<number, TagRow[]>([[published.id, []]]);
  return {
    getDocument: async () => ok(null),
    getDocumentByDocid: async () => ok(null),
    getDocumentByUri: async () => ok(null),
    getContent: async () => ok(null),
    getTagsForDoc: async () => ok([]),
    appendEgressAuditReceiptWithRetention: async () => ok("inserted" as const),
    enforceEgressAuditRetention: async () =>
      ok({ deleted: 0, remainingReceipts: 1, remainingBytes: 128 }),
    getContentBatch: async () => ok(content),
    getTagsBatch: async () => ok(tags),
    listDocuments: async () => ok([published]),
  } as unknown as StorePort;
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
};

const writePublishArtifact = async (
  path: string,
  artifact: PublishArtifact
): Promise<void> => {
  await Bun.write(path, serializePublishArtifact(artifact));
};

const main = async (): Promise<void> => {
  const outDir = parseOutDir(Bun.argv);
  await mkdir(outDir, { recursive: true });

  const root = await mkdtemp(join(tmpdir(), "gno-smoke-emit-"));
  try {
    await Bun.write(join(root, "dot.png"), PNG_1X1);
    const collections: Collection[] = [
      {
        exclude: [],
        include: [],
        name: "smoke",
        path: root,
        pattern: "**/*",
      },
    ];

    const rasterNote = buildDocument({
      id: 1,
      relPath: "home.md",
      title: "Smoke Home",
    });
    const rasterMarkdown = `# Smoke Home\n\n${MARKER}\n\n![[dot.png]]\n![ext](https://cdn.example/smoke.png)\n`;
    const rasterStore = buildStore(rasterNote, rasterMarkdown);

    const plainNote = buildDocument({
      id: 2,
      relPath: "plain.md",
      title: "Plain Smoke",
    });
    const plainMarkdown = `# Plain Smoke\n\nNo local images.\n`;
    const plainStore = buildStore(plainNote, plainMarkdown);

    const publicExport = await exportPublishArtifact({
      collections,
      options: { routeSlug: "smoke-public", visibility: "public" },
      store: rasterStore,
      target: "smoke",
    });
    const secretExport = await exportPublishArtifact({
      collections,
      options: { routeSlug: "smoke-secret", visibility: "secret-link" },
      store: rasterStore,
      target: "smoke",
    });
    const encryptedExport = await exportPublishArtifact({
      collections,
      options: {
        encryptionPassphrase: PASSPHRASE,
        routeSlug: "smoke-encrypted",
        visibility: "encrypted",
      },
      store: rasterStore,
      target: "smoke",
    });
    const legacyExport = await exportPublishArtifact({
      collections,
      options: { routeSlug: "smoke-legacy", visibility: "public" },
      store: plainStore,
      target: "smoke",
    });

    for (const [label, artifact] of [
      ["public", publicExport.artifact],
      ["secret", secretExport.artifact],
      ["encrypted", encryptedExport.artifact],
      ["legacy", legacyExport.artifact],
    ] as const) {
      const contract = validatePublishAssetContract(artifact);
      if (!contract.ok) {
        throw new Error(
          `${label}: contract failed ${contract.diagnostic.code}: ${contract.diagnostic.message}`
        );
      }
    }

    if (publicExport.artifact.version !== 1) {
      throw new Error("expected public v1 artifact");
    }
    const publicAsset = publicExport.artifact.assets?.[0];
    if (!publicAsset) {
      throw new Error("public artifact missing bundled raster asset");
    }
    if (
      !publicExport.artifact.requiredCapabilities?.includes(
        BUNDLED_RASTER_ASSETS_CAPABILITY
      )
    ) {
      throw new Error("public artifact missing bundled-raster-assets@1");
    }

    await writePublishArtifact(
      join(outDir, "public-raster.json"),
      publicExport.artifact
    );
    await writePublishArtifact(
      join(outDir, "secret-raster.json"),
      secretExport.artifact
    );
    await writePublishArtifact(
      join(outDir, "encrypted-raster.json"),
      encryptedExport.artifact
    );
    await writePublishArtifact(
      join(outDir, "legacy-asset-free.json"),
      legacyExport.artifact
    );

    const manifest = {
      assetDigest: publicAsset.sha256,
      capability: BUNDLED_RASTER_ASSETS_CAPABILITY,
      encryptedPassphrase: PASSPHRASE,
      marker: MARKER,
      mediaType: publicAsset.mediaType,
      producer: "gno-emit-publish-smoke-artifacts",
      publicFinalUploadBytes: measureArtifactUploadBytes(publicExport.artifact),
      publicRouteSlug: "smoke-public",
      secretRouteSlug: "smoke-secret",
    };
    await writeJson(join(outDir, "manifest.json"), manifest);

    console.log(
      JSON.stringify(
        {
          ok: true,
          outDir,
          assetDigest: publicAsset.sha256,
          files: [
            "public-raster.json",
            "secret-raster.json",
            "encrypted-raster.json",
            "legacy-asset-free.json",
            "manifest.json",
          ],
        },
        null,
        2
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await main();
