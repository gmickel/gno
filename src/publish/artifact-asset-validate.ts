/**
 * Fail-closed runtime validation for optional publish raster assets.
 *
 * @module src/publish/artifact-asset-validate
 */

import { measureArtifactUploadBytes } from "./artifact-asset-codec";
import {
  BUNDLED_RASTER_ASSETS_CAPABILITY,
  MAX_PUBLISH_UPLOAD_BYTES,
  type PublishArtifactAsset,
  type PublishAssetContractResult,
  type ValidatePublishAssetContractOptions,
} from "./artifact-asset-contract";
import {
  collectMarkdownSentinels,
  fail,
  readAssets,
  readRequiredCapabilities,
  type ContractFailure,
} from "./artifact-asset-parse";

type NoteIndex = {
  markdownBySlug: Map<string, string[]>;
  slugs: Set<string>;
};

const collectNoteIndex = (artifact: Record<string, unknown>): NoteIndex => {
  const markdownBySlug = new Map<string, string[]>();
  const slugs = new Set<string>();
  const spaces = Array.isArray(artifact.spaces) ? artifact.spaces : [];
  for (const space of spaces) {
    if (!(space && typeof space === "object" && !Array.isArray(space)))
      continue;
    const record = space as Record<string, unknown>;
    if (!Array.isArray(record.notes)) continue;
    for (const note of record.notes) {
      if (!(note && typeof note === "object" && !Array.isArray(note))) continue;
      const noteRecord = note as Record<string, unknown>;
      if (typeof noteRecord.slug !== "string") continue;
      slugs.add(noteRecord.slug);
      if (typeof noteRecord.markdown === "string") {
        const markdownEntries = markdownBySlug.get(noteRecord.slug) ?? [];
        markdownEntries.push(noteRecord.markdown);
        markdownBySlug.set(noteRecord.slug, markdownEntries);
      }
    }
  }
  return { markdownBySlug, slugs };
};

const collectNoteMarkdown = (notes: NoteIndex): Array<string> =>
  [...notes.markdownBySlug.values()].flat();

const validateReferenceOwnership = (
  assets: Array<PublishArtifactAsset>,
  notes: NoteIndex,
  sentinelOwners: Map<string, Set<string>>
): ContractFailure | null => {
  for (const [index, asset] of assets.entries()) {
    const field = `assets[${index}]`;
    const owners = sentinelOwners.get(asset.id) ?? new Set<string>();
    if (owners.size === 0) {
      return fail(
        "ASSET_MISSING",
        `${field} has no matching gno-asset sentinel in any artifact note`
      );
    }
    const claimed = new Set<string>();
    for (const [refIndex, reference] of asset.references.entries()) {
      if (!notes.slugs.has(reference.noteSlug)) {
        return fail(
          "ASSET_MISSING",
          `${field}.references[${refIndex}].noteSlug "${reference.noteSlug}" does not own an artifact note`
        );
      }
      claimed.add(reference.noteSlug);
      if (!owners.has(reference.noteSlug)) {
        return fail(
          "ASSET_SENTINEL_UNRESOLVED",
          `${field}.references[${refIndex}] claims note "${reference.noteSlug}" without a matching gno-asset sentinel`
        );
      }
    }
    for (const owner of owners) {
      if (!claimed.has(owner)) {
        return fail(
          "ASSET_SENTINEL_UNRESOLVED",
          `${field} is referenced by note "${owner}" but references[] omits that ownership`
        );
      }
    }
  }
  return null;
};

/**
 * Executable producer/consumer contract for optional raster assets.
 * Legacy asset-free v1/v2 artifacts remain accepted.
 */
export const validatePublishAssetContract = (
  artifact: unknown,
  options: ValidatePublishAssetContractOptions = {}
): PublishAssetContractResult => {
  if (!(artifact && typeof artifact === "object" && !Array.isArray(artifact))) {
    return fail("ASSET_CORRUPT", "Artifact must be an object");
  }
  const record = artifact as Record<string, unknown>;
  const serializedBytes =
    options.serializedUploadBytes ?? measureArtifactUploadBytes(artifact);
  if (serializedBytes > MAX_PUBLISH_UPLOAD_BYTES) {
    return fail(
      "ENVELOPE_OVERSIZE",
      `Final serialized upload is ${serializedBytes} bytes; max is ${MAX_PUBLISH_UPLOAD_BYTES}`
    );
  }

  const capabilitiesResult = readRequiredCapabilities(
    record.requiredCapabilities
  );
  if (!capabilitiesResult.ok) return capabilitiesResult;
  const assetsResult = readAssets(record.assets);
  if (!assetsResult.ok) return assetsResult;

  const { capabilities } = capabilitiesResult;
  const { assets } = assetsResult;
  const requiresBundled = capabilities.includes(
    BUNDLED_RASTER_ASSETS_CAPABILITY
  );
  const notes = collectNoteIndex(record);
  const version = record.version;

  if (version === 2) {
    if (assets.length > 0) {
      return fail(
        "ASSET_CONFLICT",
        "Encrypted v2 artifacts must not carry plaintext assets on the outer envelope"
      );
    }
    for (const markdown of collectNoteMarkdown(notes)) {
      const sentinels = collectMarkdownSentinels(markdown);
      if (!sentinels.ok) return sentinels;
      if (sentinels.ids.size > 0) {
        return fail(
          "ASSET_SENTINEL_RAW",
          "Encrypted v2 outer envelopes must not contain plaintext gno-asset sentinels"
        );
      }
    }
    if (requiresBundled) {
      return { ok: true, classification: "encrypted-client-payload" };
    }
    return { ok: true, classification: "asset-free" };
  }

  const referencedIds = new Set<string>();
  const sentinelOwners = new Map<string, Set<string>>();
  for (const [slug, markdownEntries] of notes.markdownBySlug.entries()) {
    for (const markdown of markdownEntries) {
      const sentinels = collectMarkdownSentinels(markdown);
      if (!sentinels.ok) return sentinels;
      for (const id of sentinels.ids) {
        referencedIds.add(id);
        const owners = sentinelOwners.get(id) ?? new Set<string>();
        owners.add(slug);
        sentinelOwners.set(id, owners);
      }
    }
  }

  if (referencedIds.size > 0 && !requiresBundled && assets.length === 0) {
    return fail(
      "ASSET_SENTINEL_RAW",
      "Unresolved gno-asset sentinels must never reach render; declare bundled-raster-assets@1 and include assets"
    );
  }

  if (assets.length > 0 && !requiresBundled) {
    return fail(
      "CAPABILITY_UNSUPPORTED",
      "assets require requiredCapabilities to include bundled-raster-assets@1"
    );
  }

  if (assets.length === 0 && referencedIds.size === 0) {
    return { ok: true, classification: "asset-free" };
  }

  for (const id of referencedIds) {
    if (!assets.some((asset) => asset.id === id)) {
      return fail(
        "ASSET_MISSING",
        `Markdown references gno-asset:${id} but no matching asset descriptor is present`
      );
    }
  }

  if (referencedIds.size > 0 && assets.length === 0) {
    return fail(
      "ASSET_MISSING",
      "Markdown contains gno-asset sentinels but assets[] is empty"
    );
  }

  const ownership = validateReferenceOwnership(assets, notes, sentinelOwners);
  if (ownership) return ownership;

  return { ok: true, classification: "bundled-raster-v1" };
};
