/**
 * Client-encrypted publish payload builder (v2).
 * Raster assets are embedded only inside AES-GCM plaintext ReaderSpaceData.
 *
 * @module src/publish/encrypted-export
 */

import type {
  EncryptedArtifactPayload,
  PublishArtifactAsset,
  PublishArtifactNote,
} from "./artifact";

import { encodeBytesToBase64 } from "./artifact-asset-codec";
import { BUNDLED_RASTER_ASSETS_CAPABILITY } from "./artifact-asset-contract";

const PBKDF2_ITERATIONS = 210_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MetadataEntry = {
  label: string;
  value: string;
};

type NoteBlock =
  | { type: "paragraph"; text: string }
  | { type: "markdown"; markdown: string }
  | { type: "heading"; depth: 2 | 3; id: string; text: string }
  | { type: "list"; items: string[]; style: "ordered" | "unordered" }
  | { code: string; language: string; type: "code" }
  | { alt: string; caption: string; src: string; type: "image" };

type ReaderNoteCard = {
  backlinks: Array<{
    excerpt: string;
    noteId: string;
    slug: string;
    title: string;
  }>;
  blocks: NoteBlock[];
  excerpt: string;
  metadata: MetadataEntry[];
  noteId: string;
  outline: Array<{ depth: 2 | 3; id: string; text: string }>;
  related: Array<{
    excerpt: string;
    noteId: string;
    score: number;
    slug: string;
    title: string;
  }>;
  slug: string;
  summary: string;
  title: string;
};

/** AES-GCM plaintext shape for encrypted shares (assets stay client-only). */
export type EncryptedReaderSpaceData = {
  /** Always empty — encrypted shares never project server asset manifests. */
  assetManifest: [];
  /** Validated descriptors + base64 bytes; omitted when asset-free. */
  assets?: PublishArtifactAsset[];
  currentNote: ReaderNoteCard;
  homeNoteSlug?: string;
  metadataPreview: MetadataEntry[];
  nextNoteSlug?: string;
  noteCards: ReaderNoteCard[];
  previousNoteSlug?: string;
  requiredCapabilities?: Array<typeof BUNDLED_RASTER_ASSETS_CAPABILITY>;
  searchIndex: Array<{
    excerpt: string;
    haystack: string;
    noteId: string;
    slug: string;
    title: string;
  }>;
  shareLabel: string;
  sharePath: string;
  snapshot: {
    createdAt: string;
    id: string;
    lastIndexedAt: string;
    searchEnabled: boolean;
    version: number;
  };
  sourceType: "note" | "collection";
  summary: string;
  title: string;
  visibility: "encrypted";
};

const toBase64 = (value: Uint8Array): string => encodeBytesToBase64(value);

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength
  ) as ArrayBuffer;

const stripFrontmatter = (markdown: string) => {
  if (!markdown.startsWith("---\n")) {
    return markdown;
  }

  const endIndex = markdown.indexOf("\n---\n");
  if (endIndex === -1) {
    return markdown;
  }

  return markdown.slice(endIndex + 5);
};

const filterMetadata = (
  metadata?: Record<string, string | string[]>
): MetadataEntry[] => {
  if (!metadata) {
    return [];
  }

  return Object.entries(metadata).map(([key, value]) => ({
    label: key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (char) => char.toUpperCase()),
    value: Array.isArray(value) ? value.join(", ") : value,
  }));
};

const parseMarkdownBlocks = (markdown: string): NoteBlock[] => [
  {
    type: "markdown",
    markdown: stripFrontmatter(markdown).trim(),
  },
];

const getOutline = (blocks: NoteBlock[]) =>
  blocks.flatMap((block) =>
    block.type === "heading"
      ? [{ depth: block.depth, id: block.id, text: block.text }]
      : []
  );

const makeToken = (slug: string) =>
  `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const deriveExcerpt = (summary: string, blocks: NoteBlock[]) => {
  if (summary.trim()) {
    return summary.trim();
  }

  const paragraph = blocks.find((block) => block.type === "paragraph");
  return paragraph?.text.slice(0, 160) ?? "";
};

const deriveReaderPayload = (input: {
  assets: PublishArtifactAsset[];
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}): { payload: EncryptedReaderSpaceData; secretToken: string } => {
  const noteCards: ReaderNoteCard[] = input.notes.map((note) => {
    const blocks = parseMarkdownBlocks(note.markdown);
    return {
      noteId: `${input.routeSlug}:${note.slug}`,
      slug: note.slug,
      title: note.title,
      excerpt: deriveExcerpt(note.summary, blocks),
      summary: note.summary,
      blocks,
      metadata: filterMetadata(note.metadata),
      outline: getOutline(blocks),
      backlinks: [],
      related: [],
    };
  });

  const currentNote =
    (input.homeNoteSlug
      ? noteCards.find((note) => note.slug === input.homeNoteSlug)
      : undefined) ?? noteCards[0];

  if (!currentNote) {
    throw new Error(
      `Encrypted publish "${input.routeSlug}" requires at least one note`
    );
  }

  const currentIndex = noteCards.findIndex(
    (note) => note.noteId === currentNote.noteId
  );
  const sharePath = `/locked/${makeToken(input.routeSlug)}`;
  const hasAssets = input.assets.length > 0;

  const payload: EncryptedReaderSpaceData = {
    sharePath,
    shareLabel: "Encrypted share",
    visibility: "encrypted",
    sourceType: input.sourceType,
    title: input.title,
    summary: input.summary,
    snapshot: {
      id: `snapshot-${input.routeSlug}-encrypted-v1`,
      version: 1,
      createdAt: input.exportedAt,
      lastIndexedAt: input.exportedAt,
      searchEnabled: noteCards.length > 1,
    },
    metadataPreview: [],
    assetManifest: [],
    searchIndex: noteCards.map((note) => ({
      noteId: note.noteId,
      slug: note.slug,
      title: note.title,
      excerpt: note.excerpt,
      haystack: `${note.title} ${note.summary}`.toLowerCase(),
    })),
    noteCards,
    currentNote,
    previousNoteSlug: noteCards[currentIndex - 1]?.slug,
    nextNoteSlug: noteCards[currentIndex + 1]?.slug,
    homeNoteSlug: input.homeNoteSlug ?? noteCards[0]?.slug,
  };

  if (hasAssets) {
    payload.assets = input.assets;
    payload.requiredCapabilities = [BUNDLED_RASTER_ASSETS_CAPABILITY];
  }

  return {
    payload,
    secretToken: sharePath.replace("/locked/", ""),
  };
};

const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  usages: KeyUsage[]
) => {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    usages
  );
};

const encryptJson = async (
  passphrase: string,
  payload: unknown
): Promise<EncryptedArtifactPayload> => {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    plaintext
  );

  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    salt: toBase64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
};

export const decryptEncryptedArtifactPayload = async <
  T = EncryptedReaderSpaceData,
>(
  passphrase: string,
  payload: EncryptedArtifactPayload
): Promise<T> => {
  const key = await deriveKey(passphrase, fromBase64(payload.salt), [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(fromBase64(payload.iv)) },
    key,
    toArrayBuffer(fromBase64(payload.ciphertext))
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
};

export const buildEncryptedArtifactPayload = async (input: {
  assets?: PublishArtifactAsset[];
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  passphrase: string;
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}) => {
  const { payload, secretToken } = deriveReaderPayload({
    assets: input.assets ?? [],
    exportedAt: input.exportedAt,
    homeNoteSlug: input.homeNoteSlug,
    notes: input.notes,
    routeSlug: input.routeSlug,
    sourceType: input.sourceType,
    summary: input.summary,
    title: input.title,
  });

  return {
    encryptedPayload: await encryptJson(input.passphrase, payload),
    secretToken,
  };
};
