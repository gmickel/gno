export const CLIPPER_SCHEMA_VERSION = "1.0" as const;

export type WarningCode =
  | "authenticated_visible_content"
  | "canonical_url_differs"
  | "edited_content"
  | "line_endings_normalized"
  | "reader_partial"
  | "selection_truncated"
  | "spa_snapshot"
  | "unicode_normalized";

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

export type ReaderBlock =
  | { type: "paragraph"; content: InlineNode[] }
  | { type: "heading"; level: number; content: InlineNode[] }
  | { type: "quote"; content: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "code"; language: string | null; text: string }
  | { type: "horizontal_rule" };

export interface ExtractionResult {
  sourceUrl: string;
  canonicalUrl: string | null;
  title: string;
  author: string | null;
  site: string | null;
  publishedAt: string | null;
  observedAt: string;
  browser: {
    name: string;
    version: string | null;
    platform: string | null;
  };
  warnings: WarningCode[];
  selectionText: string | null;
  readerBlocks: ReaderBlock[];
}

export interface Destination {
  collection: string;
  relPath: string | null;
  folderPath: string | null;
  collisionPolicy: "error" | "open_existing" | "create_with_suffix";
}

interface CommonPayload extends Omit<
  ExtractionResult,
  "warnings" | "selectionText" | "readerBlocks"
> {
  schemaVersion: "1.0";
  extraction: {
    visibility: "user_visible";
    authenticated: boolean;
    extractorVersion: string;
    warnings: WarningCode[];
  };
  destination: Destination;
  tags: string[];
  note: string | null;
}

export type BrowserClipPayload =
  | (CommonPayload & {
      mode: "selection";
      selection: { exactText: string; editedMarkdown: string | null };
    })
  | (CommonPayload & {
      mode: "reader";
      reader: { blocks: ReaderBlock[]; editedMarkdown: string | null };
    });

export interface StoredGrant {
  grantId: string;
  grantToken: string;
  expiresAt: string;
}

export interface PendingCapture {
  payload: BrowserClipPayload;
  previewDigest: string;
  idempotencyKey: string;
}

export interface ClipperLocalState {
  gatewayOrigin: string | null;
  grant: StoredGrant | null;
  pending: PendingCapture | null;
}

export interface PairStart {
  pairId: string;
  pairingCode: string;
  expiresAt: string;
  origin: string;
  approvalPath: "/api/clipper/pair/approve";
}

export type PairStatus =
  | { status: "pending"; expiresAt: string }
  | ({ status: "approved" } & StoredGrant)
  | {
      status: "consumed" | "expired" | "not_found" | "origin_mismatch";
    };

export interface BrowserClipPreview {
  preview: {
    body: string;
    digest: string;
    source: Record<string, unknown>;
    destination: Destination;
    tags: string[];
  };
  provenance: Record<string, unknown>;
  plan: {
    collection: string;
    relPath: string;
    outcome:
      | "created"
      | "opened_existing"
      | "created_with_suffix"
      | "overwritten"
      | "conflict";
    provenanceConflict: boolean;
  };
}

export interface CaptureReceipt {
  uri: string;
  docid?: string;
  collection: string;
  relPath: string;
  absPath?: string;
  created: boolean;
  openedExisting: boolean;
  createdWithSuffix: boolean;
  overwritten?: boolean;
  contentHash: string;
  source: Record<string, unknown>;
  tags: string[];
  sync: { status: string };
  embed: { status: string };
  collisionPolicyResult:
    | "created"
    | "opened_existing"
    | "created_with_suffix"
    | "overwritten"
    | "conflict";
  serverInstanceId?: string;
}
