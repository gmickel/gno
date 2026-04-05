/**
 * Public SDK types.
 *
 * @module src/sdk/types
 */

import type { Config } from "../config/types";
import type { NoteCollisionPolicy } from "../core/note-creation";
import type { NotePresetId } from "../core/note-presets";
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

export type GnoQueryOptions = HybridSearchOptions & GnoModelOverrides;
export type GnoAskOptions = AskOptions & GnoModelOverrides;
export type GnoVectorSearchOptions = SearchOptions & {
  model?: string;
};

export interface GnoGetOptions {
  from?: number;
  limit?: number;
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

export interface GnoClient {
  readonly config: Config;
  readonly dbPath: string;
  readonly configPath: string | null;
  readonly configSource: "file" | "inline";
  isOpen(): boolean;
  search(query: string, options?: SearchOptions): Promise<SearchResults>;
  vsearch(
    query: string,
    options?: GnoVectorSearchOptions
  ): Promise<SearchResults>;
  query(query: string, options?: GnoQueryOptions): Promise<SearchResults>;
  ask(query: string, options?: GnoAskOptions): Promise<AskResult>;
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
  status(): Promise<IndexStatus>;
  update(options?: GnoUpdateOptions): Promise<SyncResult>;
  embed(options?: GnoEmbedOptions): Promise<GnoEmbedResult>;
  index(options?: GnoIndexOptions): Promise<GnoIndexResult>;
  createNote(options: GnoCreateNoteOptions): Promise<GnoCreateNoteResult>;
  createFolder(options: GnoCreateFolderOptions): Promise<GnoCreateFolderResult>;
  getSections(ref: string): Promise<DocumentSection[]>;
  close(): Promise<void>;
}
