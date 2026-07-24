/**
 * Public SDK types.
 *
 * @module src/sdk/types
 */

import type {
  ContextCapsuleBuildInput,
  ContextRuntimeErrorCode,
} from "../app/context-runtime";
import type { Config } from "../config/types";
import type { CaptureInput, CaptureReceipt } from "../core/capture";
import type {
  ContextCapsuleErrorCode,
  ContextCapsuleV1,
  ContextCapsuleVerification,
} from "../core/context-capsule";
import type { ContextEvidenceErrorCode } from "../core/context-evidence";
import type { ContextVerifierErrorCode } from "../core/context-verifier";
import type {
  KnowledgeChangesResult,
  KnowledgeDiffResult,
  KnowledgeImpactInput,
  KnowledgeImpactResult,
  ListKnowledgeChangesInput,
} from "../core/knowledge-delta";
import type { NoteCollisionPolicy } from "../core/note-creation";
import type { NotePresetId } from "../core/note-presets";
import type {
  RetrievalTraceDeleteResult,
  RetrievalTraceDetail,
  RetrievalTraceExportRequest,
  RetrievalTraceExportResult,
  RetrievalTraceLabelRequest,
  RetrievalTraceLabelResult,
  RetrievalTraceListRequest,
  RetrievalTraceListResult,
  RetrievalTracePurgeResult as RetrievalTraceManagementPurgeResult,
} from "../core/retrieval-trace-management";
import type { DocumentSection } from "../core/sections";
import type { SyncResult } from "../ingestion";
import type { DownloadPolicy } from "../llm/policy";
import type {
  AskOptions,
  AskResult,
  HybridSearchOptions,
  SearchOptions,
  SearchResults,
} from "../pipeline/types";
import type { IndexStatus } from "../store/types";

export type {
  AskResult,
  Config,
  DownloadPolicy,
  IndexStatus,
  SearchOptions,
  SearchResults,
  SyncResult,
};
export type { AskOptions, HybridSearchOptions } from "../pipeline/types";
export type {
  KnowledgeChange,
  KnowledgeChangesResult,
  KnowledgeDiffResult,
  KnowledgeImpactEvidenceStep,
  KnowledgeImpactInput,
  KnowledgeImpactResult,
  ListKnowledgeChangesInput,
} from "../core/knowledge-delta";
export type { Collection, Config as GnoConfig, Context } from "../config/types";
export type { GetResponse as GnoGetResult } from "../cli/commands/get";
export type {
  LsResponse as GnoListResult,
  LsDocument as GnoListDocument,
} from "../cli/commands/ls";
export type {
  MultiGetDocument as GnoMultiGetDocument,
  MultiGetResponse as GnoMultiGetResult,
  SkippedDoc as GnoSkippedDocument,
} from "../cli/commands/multi-get";

export interface GnoClientInitOptions {
  config?: Config;
  configPath?: string;
  dbPath?: string;
  /** Filesystem-safe index name: 1-64 Unicode letters/marks/numbers plus ` ._-`. */
  indexName?: string;
  cacheDir?: string;
  downloadPolicy?: DownloadPolicy;
}

export interface GnoModelOverrides {
  embedModel?: string;
  expandModel?: string;
  genModel?: string;
  rerankModel?: string;
}

export interface GnoProjectHintOptions {
  /** Opaque caller project hints; never resolved against the server filesystem. */
  projectHints?: string[];
}

export type GnoSearchOptions = Omit<SearchOptions, "projectAffinity"> &
  GnoProjectHintOptions;
export type GnoQueryOptions = Omit<HybridSearchOptions, "projectAffinity"> &
  GnoModelOverrides &
  GnoProjectHintOptions;
export type GnoAskOptions = Omit<AskOptions, "projectAffinity"> &
  GnoModelOverrides &
  GnoProjectHintOptions;
export type GnoVectorSearchOptions = Omit<SearchOptions, "projectAffinity"> &
  GnoProjectHintOptions & {
    model?: string;
  };

export type GnoContextInput = Omit<ContextCapsuleBuildInput, "indexName"> &
  GnoProjectHintOptions;
export type GnoContextResult = ContextCapsuleV1;
export type GnoContextVerificationResult = ContextCapsuleVerification;
export type GnoContextErrorCode =
  | ContextRuntimeErrorCode
  | ContextCapsuleErrorCode
  | ContextEvidenceErrorCode
  | ContextVerifierErrorCode;

export interface GnoGetOptions {
  from?: number;
  limit?: number;
  /** Continue an open retrieval trace returned by search/query. */
  traceId?: string;
}

export interface GnoMultiGetOptions {
  maxBytes?: number;
}

export interface GnoListOptions {
  scope?: string;
  limit?: number;
  offset?: number;
}

export interface GnoUpdateOptions {
  collection?: string;
  gitPull?: boolean;
}

export interface GnoEmbedOptions {
  collection?: string;
  model?: string;
  batchSize?: number;
  force?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface GnoEmbedResult {
  embedded: number;
  errors: number;
  duration: number;
  model: string;
  searchAvailable: boolean;
}

export interface GnoIndexOptions extends GnoUpdateOptions, GnoEmbedOptions {
  noEmbed?: boolean;
}

export interface GnoIndexResult {
  syncResult: SyncResult;
  embedSkipped: boolean;
  embedResult?: GnoEmbedResult;
}

export interface GnoCreateNoteOptions {
  collection: string;
  title?: string;
  relPath?: string;
  folderPath?: string;
  content?: string;
  collisionPolicy?: NoteCollisionPolicy;
  presetId?: NotePresetId;
  tags?: string[];
}

export interface GnoCreateNoteResult {
  uri: string;
  path: string;
  relPath: string;
  created: boolean;
  openedExisting: boolean;
  createdWithSuffix?: boolean;
}

export interface GnoCaptureOptions extends Omit<CaptureInput, "overwrite"> {}

export type GnoCaptureResult = CaptureReceipt;

export interface GnoCreateFolderOptions {
  collection: string;
  name: string;
  parentPath?: string;
}

export interface GnoCreateFolderResult {
  collection: string;
  folderPath: string;
  path: string;
}

export interface GnoRenameNoteOptions {
  ref: string;
  name: string;
}

export interface GnoMoveNoteOptions {
  ref: string;
  folderPath: string;
  name?: string;
}

export interface GnoDuplicateNoteOptions {
  ref: string;
  folderPath?: string;
  name?: string;
}

export interface GnoRefactorNoteResult {
  uri: string;
  path: string;
  relPath: string;
  warnings: string[];
}

export interface GnoClient {
  readonly config: Config;
  readonly dbPath: string;
  readonly configPath: string | null;
  readonly configSource: "file" | "inline";
  isOpen(): boolean;
  search(query: string, options?: GnoSearchOptions): Promise<SearchResults>;
  vsearch(
    query: string,
    options?: GnoVectorSearchOptions
  ): Promise<SearchResults>;
  query(query: string, options?: GnoQueryOptions): Promise<SearchResults>;
  ask(query: string, options?: GnoAskOptions): Promise<AskResult>;
  context(input: GnoContextInput): Promise<GnoContextResult>;
  verifyContext(
    capsule: ContextCapsuleV1
  ): Promise<GnoContextVerificationResult>;
  get(
    ref: string,
    options?: GnoGetOptions
  ): Promise<import("../cli/commands/get").GetResponse>;
  multiGet(
    refs: string[],
    options?: GnoMultiGetOptions
  ): Promise<import("../cli/commands/multi-get").MultiGetResponse>;
  list(
    options?: GnoListOptions
  ): Promise<import("../cli/commands/ls").LsResponse>;
  changes(options?: ListKnowledgeChangesInput): Promise<KnowledgeChangesResult>;
  diff(ref: string, changeId?: string): Promise<KnowledgeDiffResult>;
  impact(
    ref: string,
    options?: KnowledgeImpactInput
  ): Promise<KnowledgeImpactResult>;
  status(): Promise<IndexStatus>;
  listRetrievalTraces(
    options?: RetrievalTraceListRequest
  ): Promise<RetrievalTraceListResult>;
  getRetrievalTrace(
    traceId: string,
    options?: { detailLimit?: number }
  ): Promise<RetrievalTraceDetail>;
  labelRetrievalTrace(
    input: RetrievalTraceLabelRequest
  ): Promise<RetrievalTraceLabelResult>;
  exportRetrievalTraces(
    input: RetrievalTraceExportRequest
  ): Promise<RetrievalTraceExportResult>;
  deleteRetrievalTrace(traceId: string): Promise<RetrievalTraceDeleteResult>;
  purgeRetrievalTraces(): Promise<RetrievalTraceManagementPurgeResult>;
  update(options?: GnoUpdateOptions): Promise<SyncResult>;
  embed(options?: GnoEmbedOptions): Promise<GnoEmbedResult>;
  index(options?: GnoIndexOptions): Promise<GnoIndexResult>;
  capture(options: GnoCaptureOptions): Promise<GnoCaptureResult>;
  createNote(options: GnoCreateNoteOptions): Promise<GnoCreateNoteResult>;
  createFolder(options: GnoCreateFolderOptions): Promise<GnoCreateFolderResult>;
  renameNote(options: GnoRenameNoteOptions): Promise<GnoRefactorNoteResult>;
  moveNote(options: GnoMoveNoteOptions): Promise<GnoRefactorNoteResult>;
  duplicateNote(
    options: GnoDuplicateNoteOptions
  ): Promise<GnoRefactorNoteResult>;
  getSections(ref: string): Promise<DocumentSection[]>;
  close(): Promise<void>;
}
