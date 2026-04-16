import { randomBytes, webcrypto } from "node:crypto";

import type { EncryptedArtifactPayload, PublishArtifactNote } from "./artifact";

import { slugify } from "./artifact";

const { subtle } = webcrypto;

const PBKDF2_ITERATIONS = 210_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

const encoder = new TextEncoder();

type MetadataEntry = {
  label: string;
  value: string;
};

type NoteBlock =
  | { type: "paragraph"; text: string }
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

type ReaderSpaceData = {
  assetManifest: [];
  currentNote: ReaderNoteCard;
  homeNoteSlug?: string;
  metadataPreview: MetadataEntry[];
  nextNoteSlug?: string;
  noteCards: ReaderNoteCard[];
  previousNoteSlug?: string;
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

const toBase64 = (value: Uint8Array) => Buffer.from(value).toString("base64");

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

const parseMarkdownBlocks = (markdown: string): NoteBlock[] => {
  const blocks: NoteBlock[] = [];
  const lines = stripFrontmatter(markdown).split("\n");
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeFence: { code: string[]; language: string } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    blocks.push({
      type: "paragraph",
      text: paragraph.join(" ").trim(),
    });
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    blocks.push({
      type: "list",
      style: "unordered",
      items: listItems,
    });
    listItems = [];
  };

  for (const line of lines) {
    if (codeFence) {
      if (line.startsWith("```")) {
        blocks.push({
          type: "code",
          language: codeFence.language || "text",
          code: codeFence.code.join("\n"),
        });
        codeFence = null;
        continue;
      }

      codeFence.code.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const codeMatch = trimmed.match(/^```([\w-]*)$/);
    if (codeMatch) {
      flushParagraph();
      flushList();
      codeFence = { code: [], language: codeMatch[1] || "text" };
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const headingText = headingMatch[2] ?? "";
      blocks.push({
        type: "heading",
        depth: headingMatch[1] === "###" ? 3 : 2,
        id: slugify(headingText),
        text: headingText,
      });
      continue;
    }

    const imageMatch = trimmed.match(/^!\[(.*?)\]\((.*?)\)$/);
    if (imageMatch) {
      flushParagraph();
      flushList();
      const alt = imageMatch[1] ?? "";
      const src = imageMatch[2] ?? "";
      blocks.push({
        type: "image",
        alt,
        src,
        caption: alt,
      });
      continue;
    }

    const listMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push(listMatch[1] ?? "");
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    blocks.push({
      type: "paragraph",
      text: markdown.trim(),
    });
  }

  return blocks;
};

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
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}) => {
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

  return {
    payload: {
      sharePath,
      shareLabel: "Encrypted share",
      visibility: "encrypted" as const,
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
    } satisfies ReaderSpaceData,
    secretToken: sharePath.replace("/locked/", ""),
  };
};

const deriveKey = async (passphrase: string, salt: Uint8Array) => {
  const material = await subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt"]
  );
};

const encryptJson = async (
  passphrase: string,
  payload: unknown
): Promise<EncryptedArtifactPayload> => {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
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

export const buildEncryptedArtifactPayload = async (input: {
  exportedAt: string;
  homeNoteSlug?: string;
  notes: PublishArtifactNote[];
  passphrase: string;
  routeSlug: string;
  sourceType: "note" | "collection";
  summary: string;
  title: string;
}) => {
  const { payload, secretToken } = deriveReaderPayload(input);

  return {
    encryptedPayload: await encryptJson(input.passphrase, payload),
    secretToken,
  };
};
