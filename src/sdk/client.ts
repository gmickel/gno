/**
 * GNO SDK client.
 *
 * @module src/sdk/client
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Config } from "../config/types";
import type { DownloadPolicy } from "../llm/policy";
import type { EmbeddingPort, GenerationPort, RerankPort } from "../llm/types";
import type { AskResult, SearchResults } from "../pipeline/types";
import type { IndexStatus, StoreResult } from "../store/types";
import type { VectorIndexPort } from "../store/vector";
import type {
  GnoAskOptions,
  GnoCaptureOptions,
  GnoCaptureResult,
  GnoClient,
  GnoCreateFolderOptions,
  GnoCreateFolderResult,
  GnoCreateNoteOptions,
  GnoCreateNoteResult,
  GnoContextInput,
  GnoContextResult,
  GnoContextVerificationResult,
  GnoClientInitOptions,
  GnoDuplicateNoteOptions,
  GnoEmbedOptions,
  GnoEmbedResult,
  GnoGetOptions,
  GnoIndexOptions,
  GnoIndexResult,
  GnoListOptions,
  GnoMoveNoteOptions,
  GnoMultiGetOptions,
  GnoQueryOptions,
  GnoRefactorNoteResult,
  GnoRenameNoteOptions,
  GnoSearchOptions,
  GnoUpdateOptions,
  GnoVectorSearchOptions,
  KnowledgeChangesResult,
  KnowledgeDiffResult,
  KnowledgeImpactInput,
  KnowledgeImpactResult,
  ListKnowledgeChangesInput,
} from "./types";

import {
  decorateUriForIndex,
  DEFAULT_INDEX_NAME,
  getIndexDbPath,
} from "../app/constants";
import {
  buildContextCapsule,
  validateContextCapsuleBuildInput,
  verifyContextCapsuleRuntime,
} from "../app/context-runtime";
import {
  canonicalizeIndexName,
  INDEX_NAME_REQUIREMENTS,
  isValidIndexName,
} from "../app/index-name";
import { buildVerifiedAsk } from "../app/verified-ask";
import {
  ConfigSchema,
  loadConfig,
  normalizeConfigContentTypes,
} from "../config";
import {
  buildCaptureReceipt,
  type CapturePlan,
  listCaptureDiskRelPaths,
  planCapture,
} from "../core/capture";
import { writeCapturePlanFile } from "../core/capture-write";
import {
  atomicWrite,
  copyFilePath,
  createFolderPath,
  renameFilePath,
} from "../core/file-ops";
import {
  buildRefactorWarnings,
  planCreateFolder,
  planDuplicateRefactor,
  planMoveRefactor,
  planRenameRefactor,
} from "../core/file-refactors";
import { resolveEffectiveIndex } from "../core/indexed-reference";
import {
  analyzeKnowledgeImpact,
  getKnowledgeDiff,
  listKnowledgeChanges,
  type KnowledgeDeltaServiceResult,
} from "../core/knowledge-delta";
import { resolveNoteCreatePlan } from "../core/note-creation";
import { resolveNotePreset } from "../core/note-presets";
import {
  ProjectAffinityInputError,
  resolveRemoteProjectAffinity,
} from "../core/project-affinity-surface";
import { RetrievalTraceManagementService } from "../core/retrieval-trace-management";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../core/retrieval-trace-request";
import {
  attachRetrievalTraceMetadata,
  getRetrievalTraceMetadata,
  RETRIEVAL_TRACE_METADATA,
  type RetrievalTraceSession,
} from "../core/retrieval-trace-session";
import { extractSections } from "../core/sections";
import { normalizeStructuredQueryInput } from "../core/structured-query";
import { parseAndValidateTagFilter } from "../core/tags";
import {
  defaultSyncService,
  type SyncResult,
  withContentTypeRules,
} from "../ingestion";
import { updateFrontmatterTags } from "../ingestion/frontmatter";
import { LlmAdapter } from "../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../llm/policy";
import { resolveModelUri } from "../llm/registry";
import {
  answerTraceTerminalStatus,
  generateGroundedAnswer,
  processAnswerResultWithTrace,
} from "../pipeline/answer";
import { formatQueryForEmbedding } from "../pipeline/contextual";
import { searchHybrid } from "../pipeline/hybrid";
import { searchBm25 } from "../pipeline/search";
import { searchVectorWithEmbedding } from "../pipeline/vsearch";
import { SqliteAdapter } from "../store/sqlite/adapter";
import { openScopedIndexStore } from "../store/sqlite/scoped-index";
import { createVectorIndexPort } from "../store/vector";
import {
  getDocumentByRef,
  listDocuments,
  multiGetDocuments,
} from "./documents";
import { runEmbed } from "./embed";
import { sdkError } from "./errors";

interface OpenedClientState {
  config: Config;
  configPath: string | null;
  configSource: "file" | "inline";
  dbPath: string;
  store: SqliteAdapter;
  llm: LlmAdapter;
  downloadPolicy: DownloadPolicy;
  indexName: string;
}

interface RuntimePorts {
  embedPort: EmbeddingPort | null;
  expandPort: GenerationPort | null;
  answerPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  vectorIndex: VectorIndexPort | null;
}

const resolveSdkProjectAffinity = async (
  config: Config,
  projectHints: readonly string[] | undefined
) => {
  try {
    return await resolveRemoteProjectAffinity(config, projectHints);
  } catch (error) {
    if (error instanceof ProjectAffinityInputError) {
      throw sdkError("VALIDATION", error.message);
    }
    throw error;
  }
};

function unwrapStore<T>(
  result: StoreResult<T>,
  code: "STORE" | "RUNTIME" = "STORE"
): T {
  if (!result.ok) {
    throw sdkError(code, result.error.message, { cause: result.error.cause });
  }
  return result.value;
}

function unwrapTraceStore<T>(result: StoreResult<T>): T {
  if (result.ok) return result.value;
  const code =
    result.error.code === "NOT_FOUND"
      ? "NOT_FOUND"
      : result.error.code === "INVALID_INPUT" ||
          result.error.code === "CONSTRAINT_VIOLATION"
        ? "VALIDATION"
        : "STORE";
  throw sdkError(code, result.error.message, {
    cause: result.error.cause,
    details: { traceCode: result.error.code },
  });
}

function unwrapKnowledgeDelta<T>(result: KnowledgeDeltaServiceResult<T>): T {
  if (result.success) return result.data;
  throw sdkError(result.isValidation ? "VALIDATION" : "STORE", result.error);
}

async function resolveClientState(
  options: GnoClientInitOptions = {}
): Promise<OpenedClientState> {
  if (options.config && options.configPath) {
    throw sdkError("VALIDATION", "Pass either config or configPath, not both");
  }

  let config: Config;
  let configPath: string | null;
  let configSource: "file" | "inline";

  if (options.config) {
    const parsed = ConfigSchema.safeParse(options.config);
    if (!parsed.success) {
      throw sdkError(
        "CONFIG",
        parsed.error.issues[0]?.message ?? "Invalid config"
      );
    }
    config = normalizeConfigContentTypes(parsed.data).config;
    configPath = null;
    configSource = "inline";
  } else {
    const loaded = await loadConfig(options.configPath);
    if (!loaded.ok) {
      throw sdkError("CONFIG", loaded.error.message);
    }
    config = loaded.value;
    configPath = options.configPath ?? null;
    configSource = "file";
  }

  const indexName = canonicalizeIndexName(
    options.indexName ?? DEFAULT_INDEX_NAME
  );
  const dbPath = options.dbPath ?? getIndexDbPath(indexName);
  await mkdir(dirname(dbPath), { recursive: true });

  const store = new SqliteAdapter();
  store.setConfigPath(configPath ?? "<inline-config>");
  unwrapStore(await store.open(dbPath, config.ftsTokenizer));
  unwrapStore(await store.syncCollections(config.collections));
  unwrapStore(await store.syncContexts(config.contexts ?? []));

  return {
    config,
    configPath,
    configSource,
    dbPath,
    store,
    llm: new LlmAdapter(config, options.cacheDir),
    downloadPolicy:
      options.downloadPolicy ?? resolveDownloadPolicy(process.env, {}),
    indexName,
  };
}

class GnoClientImpl implements GnoClient {
  readonly config: Config;
  readonly dbPath: string;
  readonly configPath: string | null;
  readonly configSource: "file" | "inline";

  private readonly store: SqliteAdapter;
  private readonly llm: LlmAdapter;
  private readonly downloadPolicy: DownloadPolicy;
  private readonly indexName: string;
  private closed = false;

  constructor(state: OpenedClientState) {
    this.config = state.config;
    this.dbPath = state.dbPath;
    this.configPath = state.configPath;
    this.configSource = state.configSource;
    this.store = state.store;
    this.llm = state.llm;
    this.downloadPolicy = state.downloadPolicy;
    this.indexName = state.indexName;
  }

  isOpen(): boolean {
    return !this.closed && this.store.isOpen();
  }

  private assertOpen(): void {
    if (!this.isOpen()) {
      throw sdkError("RUNTIME", "GNO client is closed");
    }
  }

  private getCollections(collection?: string) {
    if (!collection) {
      return this.config.collections;
    }
    const filtered = this.config.collections.filter(
      (c) => c.name === collection
    );
    if (filtered.length === 0) {
      throw sdkError("VALIDATION", `Collection not found: ${collection}`);
    }
    return filtered;
  }

  private async createRuntimePorts(options: {
    embed?: boolean;
    expand?: boolean;
    answer?: boolean;
    rerank?: boolean;
    collection?: string;
    requiredEmbed?: boolean;
    requiredExpand?: boolean;
    requiredAnswer?: boolean;
    requiredRerank?: boolean;
    embedModel?: string;
    expandModel?: string;
    genModel?: string;
    rerankModel?: string;
  }): Promise<RuntimePorts> {
    this.assertOpen();

    let embedPort: EmbeddingPort | null = null;
    let expandPort: GenerationPort | null = null;
    let answerPort: GenerationPort | null = null;
    let rerankPort: RerankPort | null = null;
    let vectorIndex: VectorIndexPort | null = null;

    if (options.embed) {
      const embedResult = await this.llm.createEmbeddingPort(
        resolveModelUri(
          this.config,
          "embed",
          options.embedModel,
          options.collection
        ),
        {
          policy: this.downloadPolicy,
        }
      );
      if (embedResult.ok) {
        embedPort = embedResult.value;
        const initResult = await embedPort.init();
        if (initResult.ok) {
          const vectorResult = await createVectorIndexPort(
            this.store.getRawDb(),
            {
              model: embedPort.modelUri,
              dimensions: embedPort.dimensions(),
            }
          );
          if (vectorResult.ok) {
            vectorIndex = vectorResult.value;
          } else if (options.requiredEmbed) {
            await embedPort.dispose();
            throw sdkError("STORE", vectorResult.error.message, {
              cause: vectorResult.error.cause,
            });
          }
        } else if (options.requiredEmbed) {
          await embedPort.dispose();
          throw sdkError("MODEL", initResult.error.message, {
            cause: initResult.error.cause,
          });
        }
      } else if (options.requiredEmbed) {
        throw sdkError("MODEL", embedResult.error.message, {
          cause: embedResult.error.cause,
        });
      }
    }

    if (options.expand) {
      const genResult = await this.llm.createExpansionPort(
        resolveModelUri(
          this.config,
          "expand",
          options.expandModel ?? options.genModel,
          options.collection
        ),
        {
          policy: this.downloadPolicy,
        }
      );
      if (genResult.ok) {
        expandPort = genResult.value;
      } else if (options.requiredExpand) {
        if (embedPort) {
          await embedPort.dispose();
        }
        throw sdkError("MODEL", genResult.error.message, {
          cause: genResult.error.cause,
        });
      }
    }

    if (options.answer) {
      const genResult = await this.llm.createGenerationPort(
        resolveModelUri(
          this.config,
          "gen",
          options.genModel,
          options.collection
        ),
        {
          policy: this.downloadPolicy,
        }
      );
      if (genResult.ok) {
        answerPort = genResult.value;
      } else if (options.requiredAnswer) {
        if (embedPort) {
          await embedPort.dispose();
        }
        if (expandPort) {
          await expandPort.dispose();
        }
        throw sdkError("MODEL", genResult.error.message, {
          cause: genResult.error.cause,
        });
      }
    }

    if (options.rerank) {
      const rerankResult = await this.llm.createRerankPort(
        resolveModelUri(
          this.config,
          "rerank",
          options.rerankModel,
          options.collection
        ),
        {
          policy: this.downloadPolicy,
        }
      );
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      } else if (options.requiredRerank) {
        if (embedPort) {
          await embedPort.dispose();
        }
        if (expandPort) {
          await expandPort.dispose();
        }
        if (answerPort) {
          await answerPort.dispose();
        }
        throw sdkError("MODEL", rerankResult.error.message, {
          cause: rerankResult.error.cause,
        });
      }
    }

    return { embedPort, expandPort, answerPort, rerankPort, vectorIndex };
  }

  private async disposeRuntimePorts(ports: RuntimePorts): Promise<void> {
    if (ports.embedPort) {
      await ports.embedPort.dispose();
    }
    if (ports.expandPort) {
      await ports.expandPort.dispose();
    }
    if (ports.answerPort) {
      await ports.answerPort.dispose();
    }
    if (ports.rerankPort) {
      await ports.rerankPort.dispose();
    }
  }

  private decorateSearchResults(results: SearchResults): SearchResults {
    return {
      ...results,
      results: results.results.map((result) => ({
        ...result,
        uri: decorateUriForIndex(result.uri, this.indexName),
      })),
    };
  }

  async search(
    query: string,
    options: GnoSearchOptions = {}
  ): Promise<SearchResults> {
    this.assertOpen();
    let traceSession: RetrievalTraceSession | null = null;
    try {
      const { projectHints, ...searchOptions } = options;
      const projectAffinity = await resolveSdkProjectAffinity(
        this.config,
        projectHints
      );
      traceSession = unwrapStore(
        await startRetrievalTraceRequest({
          store: this.store,
          config: this.config,
          query,
          filters: retrievalTraceFilters(searchOptions),
          pipeline: "bm25",
          indexName: this.indexName,
        })
      );
      return attachRetrievalTraceMetadata(
        this.decorateSearchResults(
          unwrapStore(
            await searchBm25(this.store, query, {
              ...searchOptions,
              projectAffinity,
              traceSession: traceSession ?? undefined,
            })
          )
        ),
        traceSession ?? undefined
      );
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
    }
  }

  async vsearch(
    query: string,
    options: GnoVectorSearchOptions = {}
  ): Promise<SearchResults> {
    this.assertOpen();

    let ports: RuntimePorts | null = null;
    let traceSession: RetrievalTraceSession | null = null;

    try {
      const { projectHints, ...searchOptions } = options;
      const projectAffinity = await resolveSdkProjectAffinity(
        this.config,
        projectHints
      );
      const embedUri = resolveModelUri(
        this.config,
        "embed",
        options.model,
        options.collection
      );
      traceSession = unwrapStore(
        await startRetrievalTraceRequest({
          store: this.store,
          config: this.config,
          query,
          filters: retrievalTraceFilters(searchOptions),
          pipeline: "vector",
          indexName: this.indexName,
          modelUris: [embedUri],
        })
      );
      ports = await this.createRuntimePorts({
        embed: true,
        requiredEmbed: true,
        embedModel: options.model,
        collection: options.collection,
      });
      if (!ports.embedPort || !ports.vectorIndex) {
        throw sdkError(
          "MODEL",
          "Vector search requires an embedding model and vector index"
        );
      }

      const queryEmbedResult = await ports.embedPort.embed(
        formatQueryForEmbedding(query, ports.embedPort.modelUri)
      );
      if (!queryEmbedResult.ok) {
        throw sdkError("MODEL", queryEmbedResult.error.message, {
          cause: queryEmbedResult.error.cause,
        });
      }

      return attachRetrievalTraceMetadata(
        this.decorateSearchResults(
          unwrapStore(
            await searchVectorWithEmbedding(
              {
                store: this.store,
                vectorIndex: ports.vectorIndex,
                embedPort: ports.embedPort,
                config: this.config,
              },
              query,
              new Float32Array(queryEmbedResult.value),
              {
                ...searchOptions,
                projectAffinity,
                traceSession: traceSession ?? undefined,
              }
            )
          )
        ),
        traceSession ?? undefined
      );
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
    } finally {
      if (ports) await this.disposeRuntimePorts(ports);
    }
  }

  async query(
    query: string,
    options: GnoQueryOptions = {}
  ): Promise<SearchResults> {
    this.assertOpen();

    const normalizedInput = normalizeStructuredQueryInput(
      query,
      options.queryModes ?? []
    );
    if (!normalizedInput.ok) {
      throw sdkError("VALIDATION", normalizedInput.error.message);
    }
    query = normalizedInput.value.query;
    options = {
      ...options,
      queryModes:
        normalizedInput.value.queryModes.length > 0
          ? normalizedInput.value.queryModes
          : undefined,
    };

    const expandRequested = !options.noExpand && !options.queryModes?.length;
    const rerankRequested = !options.noRerank;
    const embedUri = resolveModelUri(
      this.config,
      "embed",
      options.embedModel,
      options.collection
    );
    const expandUri = expandRequested
      ? resolveModelUri(
          this.config,
          "expand",
          options.expandModel ?? options.genModel,
          options.collection
        )
      : undefined;
    const rerankUri = rerankRequested
      ? resolveModelUri(
          this.config,
          "rerank",
          options.rerankModel,
          options.collection
        )
      : undefined;
    let ports: RuntimePorts | null = null;
    let traceSession: RetrievalTraceSession | null = null;

    try {
      const { projectHints, ...queryOptions } = options;
      const projectAffinity = await resolveSdkProjectAffinity(
        this.config,
        projectHints
      );
      traceSession = unwrapStore(
        await startRetrievalTraceRequest({
          store: this.store,
          config: this.config,
          query,
          filters: retrievalTraceFilters(queryOptions),
          pipeline: "hybrid",
          indexName: this.indexName,
          modelUris: [embedUri, expandUri, rerankUri].filter(
            (value): value is string => Boolean(value)
          ),
        })
      );
      ports = await this.createRuntimePorts({
        embed: true,
        expand: expandRequested,
        rerank: rerankRequested,
        embedModel: options.embedModel,
        expandModel: options.expandModel,
        genModel: options.genModel,
        rerankModel: options.rerankModel,
        collection: options.collection,
      });
      return attachRetrievalTraceMetadata(
        this.decorateSearchResults(
          unwrapStore(
            await searchHybrid(
              {
                store: this.store,
                config: this.config,
                vectorIndex: ports.vectorIndex,
                embedPort: ports.embedPort,
                expandPort: ports.expandPort,
                rerankPort: ports.rerankPort,
              },
              query,
              {
                ...queryOptions,
                projectAffinity,
                traceSession: traceSession ?? undefined,
              }
            )
          )
        ),
        traceSession ?? undefined
      );
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
    } finally {
      if (ports) await this.disposeRuntimePorts(ports);
    }
  }

  async ask(query: string, options: GnoAskOptions = {}): Promise<AskResult> {
    this.assertOpen();

    const normalizedInput = normalizeStructuredQueryInput(
      query,
      options.queryModes ?? []
    );
    if (!normalizedInput.ok) {
      throw sdkError("VALIDATION", normalizedInput.error.message);
    }
    query = normalizedInput.value.query;
    options = {
      ...options,
      queryModes:
        normalizedInput.value.queryModes.length > 0
          ? normalizedInput.value.queryModes
          : undefined,
    };

    const verificationRequested = options.verify === true;
    const answerRequested =
      verificationRequested || Boolean(options.answer && !options.noAnswer);
    const needsExpansionGen =
      !verificationRequested &&
      !options.noExpand &&
      !options.queryModes?.length;
    const rerankRequested = !options.noRerank;
    const embedUri = resolveModelUri(
      this.config,
      "embed",
      options.embedModel,
      options.collection
    );
    const expandUri = needsExpansionGen
      ? resolveModelUri(
          this.config,
          "expand",
          options.expandModel ?? options.genModel,
          options.collection
        )
      : undefined;
    const answerUri = answerRequested
      ? resolveModelUri(
          this.config,
          "gen",
          options.genModel,
          options.collection
        )
      : undefined;
    const rerankUri = rerankRequested
      ? resolveModelUri(
          this.config,
          "rerank",
          options.rerankModel,
          options.collection
        )
      : undefined;
    let ports: RuntimePorts | null = null;
    let traceSession: RetrievalTraceSession | null = null;

    try {
      const { projectHints, ...askOptions } = options;
      const projectAffinity = await resolveSdkProjectAffinity(
        this.config,
        projectHints
      );
      traceSession = unwrapStore(
        await startRetrievalTraceRequest({
          store: this.store,
          config: this.config,
          query,
          filters: retrievalTraceFilters(askOptions),
          pipeline: "ask",
          indexName: this.indexName,
          modelUris: [embedUri, expandUri, answerUri, rerankUri].filter(
            (value): value is string => Boolean(value)
          ),
        })
      );
      ports = await this.createRuntimePorts({
        embed: true,
        expand: needsExpansionGen,
        answer: answerRequested,
        rerank: rerankRequested,
        expandModel: options.expandModel,
        genModel: options.genModel,
        embedModel: options.embedModel,
        rerankModel: options.rerankModel,
        collection: options.collection,
      });
      if (answerRequested && !ports.answerPort) {
        await traceSession?.recordCapability(
          "answer_generation",
          "unavailable",
          "model_unavailable"
        );
        await traceSession?.finish("failed");
        throw sdkError(
          "MODEL",
          "Answer generation requested but no generation model is available"
        );
      }

      if (verificationRequested && ports.answerPort) {
        const verified = await buildVerifiedAsk(
          query,
          { ...askOptions, projectAffinity },
          {
            store: this.store,
            config: this.config,
            indexName: this.indexName,
            vectorIndex: ports.vectorIndex,
            embedPort: ports.embedPort,
            rerankPort: ports.rerankPort,
            genPort: ports.answerPort,
            projectAffinity,
            traceSession: traceSession ?? undefined,
          }
        );
        if (traceSession) {
          unwrapStore(
            await traceSession.finish(
              answerTraceTerminalStatus(verified.citations)
            )
          );
        }
        return attachRetrievalTraceMetadata(
          verified,
          traceSession ?? undefined
        );
      }

      const searchResult = unwrapStore(
        await searchHybrid(
          {
            store: this.store,
            config: this.config,
            vectorIndex: ports.vectorIndex,
            embedPort: ports.embedPort,
            expandPort: ports.expandPort,
            rerankPort: ports.rerankPort,
          },
          query,
          {
            limit: options.limit,
            collection: options.collection,
            lang: options.lang,
            intent: options.intent,
            since: options.since,
            until: options.until,
            categories: options.categories,
            author: options.author,
            tagsAll: options.tagsAll,
            tagsAny: options.tagsAny,
            exclude: options.exclude,
            minScore: options.minScore,
            graph: options.graph,
            noGraph: options.noGraph,
            queryModes: options.queryModes,
            noExpand: options.noExpand,
            noRerank: options.noRerank,
            candidateLimit: options.candidateLimit,
            queryLanguageHint: options.queryLanguageHint,
            projectAffinity,
            traceSession: traceSession ?? undefined,
          }
        )
      );

      let answer: string | undefined;
      let citations: AskResult["citations"];
      let answerContext: AskResult["meta"]["answerContext"];
      let answerGenerated = false;

      if (
        answerRequested &&
        ports.answerPort &&
        searchResult.results.length > 0
      ) {
        await traceSession?.recordCapability("answer_generation", "attempted");
        const rawAnswer = await generateGroundedAnswer(
          { genPort: ports.answerPort, store: this.store },
          query,
          searchResult.results,
          options.maxAnswerTokens ?? 512
        );
        if (!rawAnswer) {
          await traceSession?.recordCapability(
            "answer_generation",
            "failed",
            "generation_failed"
          );
          await traceSession?.finish("failed");
          throw sdkError("MODEL", "Answer generation failed");
        }
        await traceSession?.recordCapability("answer_generation", "used");
        const processed = await processAnswerResultWithTrace(
          rawAnswer,
          traceSession ?? undefined
        );
        answer = processed.answer;
        citations = processed.citations;
        answerContext = processed.answerContext;
        answerGenerated = true;
      }

      const askResult: AskResult = {
        query,
        mode: searchResult.meta.vectorsUsed ? "hybrid" : "bm25_only",
        queryLanguage: searchResult.meta.queryLanguage ?? "und",
        answer,
        citations,
        results: searchResult.results,
        meta: {
          expanded: searchResult.meta.expanded ?? false,
          reranked: searchResult.meta.reranked ?? false,
          vectorsUsed: searchResult.meta.vectorsUsed ?? false,
          intent: searchResult.meta.intent,
          candidateLimit: searchResult.meta.candidateLimit,
          exclude: searchResult.meta.exclude,
          queryModes: searchResult.meta.queryModes,
          answerGenerated,
          totalResults: searchResult.results.length,
          answerContext,
        },
      };
      if (answerRequested && traceSession) {
        if (!answerGenerated) {
          unwrapStore(
            await traceSession.recordCapability(
              "answer_generation",
              "unavailable",
              "no_evidence"
            )
          );
        }
        unwrapStore(
          await traceSession.finish(answerTraceTerminalStatus(citations))
        );
      }
      return attachRetrievalTraceMetadata(askResult, traceSession ?? undefined);
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
    } finally {
      if (ports) await this.disposeRuntimePorts(ports);
    }
  }

  async context(input: GnoContextInput): Promise<GnoContextResult> {
    this.assertOpen();
    const { projectHints, ...contextInput } = input;
    validateContextCapsuleBuildInput(
      { ...contextInput, indexName: this.indexName },
      this.indexName,
      this.config.collections.map((collection) => collection.name)
    );
    const collection =
      input.collections?.length === 1 ? input.collections[0] : undefined;
    const useModels = input.depthPolicy !== "fast";
    const modelUris = useModels
      ? [
          resolveModelUri(this.config, "embed", undefined, collection),
          resolveModelUri(this.config, "rerank", undefined, collection),
        ]
      : [];
    let ports: RuntimePorts | null = null;
    let traceSession: RetrievalTraceSession | null = null;
    try {
      const projectAffinity = await resolveSdkProjectAffinity(
        this.config,
        projectHints
      );
      traceSession = unwrapStore(
        await startRetrievalTraceRequest({
          store: this.store,
          config: this.config,
          query: input.query ?? input.goal,
          goal: input.goal,
          filters: {
            limit: input.limit,
            collection,
            collections: [...(input.collections ?? [])].sort(),
            lang: input.lang,
            tagsAll: input.tagsAll,
            tagsAny: input.tagsAny,
            since: input.since,
            until: input.until,
            categories: input.categories,
            author: input.author,
            graph: input.graph,
            candidateLimit: input.candidateLimit,
            queryModes: input.queryModes,
            uriPrefix: input.uriPrefix ?? undefined,
          },
          pipeline: "context",
          indexName: this.indexName,
          modelUris,
        })
      );
      ports = await this.createRuntimePorts({
        embed: useModels,
        rerank: useModels,
        collection,
      });
      const capsule = await buildContextCapsule(
        { ...contextInput, indexName: this.indexName },
        {
          store: this.store,
          config: this.config,
          indexName: this.indexName,
          vectorIndex: ports.vectorIndex,
          embedPort: ports.embedPort,
          rerankPort: ports.rerankPort,
          projectAffinity,
          traceSession: traceSession ?? undefined,
        }
      );
      if (traceSession) unwrapStore(await traceSession.finish("completed"));
      return attachRetrievalTraceMetadata(capsule, traceSession ?? undefined);
    } catch (cause) {
      await finishRetrievalTraceAfterError(traceSession, cause);
      throw cause;
    } finally {
      if (ports) await this.disposeRuntimePorts(ports);
    }
  }

  async verifyContext(
    capsule: GnoContextResult
  ): Promise<GnoContextVerificationResult> {
    this.assertOpen();
    return verifyContextCapsuleRuntime(capsule, {
      store: this.store,
      config: this.config,
      indexName: this.indexName,
    });
  }

  async get(ref: string, options: GnoGetOptions = {}) {
    this.assertOpen();
    const resolution = resolveEffectiveIndex([ref], this.indexName);
    if (!resolution.ok) {
      throw sdkError("VALIDATION", resolution.error);
    }
    const scoped = await openScopedIndexStore({
      activeStore: this.store,
      activeIndexName: this.indexName,
      requestedIndexName: resolution.value.indexName,
      config: this.config,
      configPath: this.configPath,
    });
    try {
      const result = await getDocumentByRef(
        scoped.store,
        this.config,
        ref,
        options
      );
      const decorated = {
        ...result,
        uri: decorateUriForIndex(result.uri, scoped.indexName),
      };
      const traceMetadata = getRetrievalTraceMetadata(result);
      if (traceMetadata) {
        Object.defineProperty(decorated, RETRIEVAL_TRACE_METADATA, {
          configurable: false,
          enumerable: false,
          value: traceMetadata,
          writable: false,
        });
      }
      return decorated;
    } finally {
      await scoped.close();
    }
  }

  async multiGet(refs: string[], options: GnoMultiGetOptions = {}) {
    this.assertOpen();
    const resolution = resolveEffectiveIndex(refs, this.indexName);
    if (!resolution.ok) {
      throw sdkError("VALIDATION", resolution.error);
    }
    const scoped = await openScopedIndexStore({
      activeStore: this.store,
      activeIndexName: this.indexName,
      requestedIndexName: resolution.value.indexName,
      config: this.config,
      configPath: this.configPath,
    });
    try {
      const result = await multiGetDocuments(
        scoped.store,
        this.config,
        refs,
        options
      );
      return {
        ...result,
        documents: result.documents.map((doc) => ({
          ...doc,
          uri: decorateUriForIndex(doc.uri, scoped.indexName),
        })),
      };
    } finally {
      await scoped.close();
    }
  }

  async list(options: GnoListOptions = {}) {
    this.assertOpen();
    const result = await listDocuments(this.store, options);
    return {
      ...result,
      documents: result.documents.map((doc) => ({
        ...doc,
        uri: decorateUriForIndex(doc.uri, this.indexName),
      })),
    };
  }

  async changes(
    options: ListKnowledgeChangesInput = {}
  ): Promise<KnowledgeChangesResult> {
    this.assertOpen();
    return unwrapKnowledgeDelta(
      await listKnowledgeChanges(this.store, options)
    );
  }

  async diff(ref: string, changeId?: string): Promise<KnowledgeDiffResult> {
    this.assertOpen();
    return unwrapKnowledgeDelta(
      await getKnowledgeDiff(this.store, ref, changeId)
    );
  }

  async impact(
    ref: string,
    options: KnowledgeImpactInput = {}
  ): Promise<KnowledgeImpactResult> {
    this.assertOpen();
    return unwrapKnowledgeDelta(
      await analyzeKnowledgeImpact(this.store, ref, options)
    );
  }

  async status(): Promise<IndexStatus> {
    this.assertOpen();
    return unwrapStore(
      await this.store.getStatus({
        embedModel: resolveModelUri(this.config, "embed"),
      })
    );
  }

  async listRetrievalTraces(
    options: import("../core/retrieval-trace-management").RetrievalTraceListRequest = {}
  ) {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).list(options)
    );
  }

  async getRetrievalTrace(
    traceId: string,
    options: { detailLimit?: number } = {}
  ) {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).show(
        traceId,
        options
      )
    );
  }

  async labelRetrievalTrace(
    input: import("../core/retrieval-trace-management").RetrievalTraceLabelRequest
  ) {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).label(input)
    );
  }

  async exportRetrievalTraces(
    input: import("../core/retrieval-trace-management").RetrievalTraceExportRequest
  ) {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).export(input)
    );
  }

  async deleteRetrievalTrace(traceId: string) {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).delete(traceId)
    );
  }

  async purgeRetrievalTraces() {
    this.assertOpen();
    return unwrapTraceStore(
      await new RetrievalTraceManagementService(this.store).purge()
    );
  }

  async update(options: GnoUpdateOptions = {}): Promise<SyncResult> {
    this.assertOpen();
    const collections = this.getCollections(options.collection);
    return defaultSyncService.syncAll(
      collections,
      this.store,
      withContentTypeRules(
        {
          gitPull: options.gitPull,
          runUpdateCmd: true,
        },
        this.config
      )
    );
  }

  async embed(options: GnoEmbedOptions = {}): Promise<GnoEmbedResult> {
    this.assertOpen();
    return runEmbed(
      {
        config: this.config,
        store: this.store,
        llm: this.llm,
        downloadPolicy: this.downloadPolicy,
      },
      options
    );
  }

  async index(options: GnoIndexOptions = {}): Promise<GnoIndexResult> {
    const syncResult = await this.update(options);
    if (options.noEmbed) {
      return { syncResult, embedSkipped: true };
    }

    const embedResult = await this.embed(options);
    return {
      syncResult,
      embedSkipped: false,
      embedResult,
    };
  }

  async createNote(
    options: GnoCreateNoteOptions
  ): Promise<GnoCreateNoteResult> {
    this.assertOpen();
    const collection = this.getCollections(options.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${options.collection}`
      );
    }

    const existingList = await this.store.listDocuments(collection.name);
    if (!existingList.ok) {
      throw sdkError("STORE", existingList.error.message, {
        cause: existingList.error.cause,
      });
    }

    const plan = resolveNoteCreatePlan(
      {
        collection: collection.name,
        title: options.title,
        relPath: options.relPath,
        folderPath: options.folderPath,
        collisionPolicy: options.collisionPolicy,
      },
      existingList.value.map((doc) => doc.relPath)
    );
    const fullPath = `${collection.path}/${plan.relPath}`;

    if (plan.openedExisting) {
      const existingDoc = await this.store.getDocument(
        collection.name,
        plan.relPath
      );
      if (!existingDoc.ok || !existingDoc.value) {
        throw sdkError("NOT_FOUND", "Existing note could not be resolved");
      }
      return {
        uri: existingDoc.value.uri,
        path: fullPath,
        relPath: plan.relPath,
        created: false,
        openedExisting: true,
      };
    }

    const validatedTags = options.tags?.length
      ? parseAndValidateTagFilter(options.tags.join(","))
      : [];
    const presetContent = resolveNotePreset({
      presetId: options.presetId,
      title:
        options.title?.trim() ||
        plan.filename.replace(/\.[^.]+$/u, "") ||
        "Untitled",
      tags: validatedTags,
      body: options.content,
    });

    let contentToWrite =
      presetContent?.content ??
      options.content ??
      `# ${options.title?.trim() || "Untitled"}\n`;
    if (
      validatedTags.length > 0 &&
      [".md", ".markdown"].includes(
        plan.filename.slice(plan.filename.lastIndexOf(".")).toLowerCase()
      )
    ) {
      contentToWrite = updateFrontmatterTags(contentToWrite, validatedTags);
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await atomicWrite(fullPath, contentToWrite);
    const syncResults = await defaultSyncService.syncFiles(
      collection,
      this.store,
      [plan.relPath],
      withContentTypeRules(
        {
          runUpdateCmd: false,
          gitPull: false,
        },
        this.config
      )
    );
    const syncResult = syncResults[0];
    if (!syncResult || syncResult.status === "error") {
      throw sdkError(
        "RUNTIME",
        syncResult?.errorMessage ?? "Failed to sync created note"
      );
    }

    return {
      uri: `gno://${collection.name}/${plan.relPath}`,
      path: fullPath,
      relPath: plan.relPath,
      created: true,
      openedExisting: false,
      createdWithSuffix: plan.createdWithSuffix,
    };
  }

  async capture(options: GnoCaptureOptions): Promise<GnoCaptureResult> {
    this.assertOpen();
    const collection = this.getCollections(options.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${options.collection}`
      );
    }

    const existingList = await this.store.listDocuments(collection.name);
    if (!existingList.ok) {
      throw sdkError("STORE", existingList.error.message, {
        cause: existingList.error.cause,
      });
    }
    const { overwrite: _unsupportedOverwrite, ...captureOptions } =
      options as GnoCaptureOptions & { overwrite?: unknown };
    if (_unsupportedOverwrite !== undefined) {
      throw sdkError(
        "VALIDATION",
        "overwrite is not supported by client.capture(); use collisionPolicy instead"
      );
    }

    let plan: CapturePlan;
    try {
      plan = planCapture({
        input: {
          ...captureOptions,
          collection: collection.name,
        },
        existingRelPaths: existingList.value.map((doc) => doc.relPath),
        diskRelPaths: await listCaptureDiskRelPaths(collection.path),
      });
    } catch (error) {
      throw sdkError(
        "VALIDATION",
        error instanceof Error ? error.message : String(error)
      );
    }

    const fullPath = `${collection.path}/${plan.relPath}`;
    if (plan.openedExisting) {
      const existingDoc = await this.store.getDocument(
        collection.name,
        plan.relPath
      );
      if (!existingDoc.ok) {
        throw sdkError("STORE", existingDoc.error.message, {
          cause: existingDoc.error.cause,
        });
      }
      return buildCaptureReceipt({
        plan,
        absPath: fullPath,
        docid: existingDoc.value?.docid,
        sync: existingDoc.value
          ? { status: "completed" }
          : {
              status: "skipped",
              reason: "Existing file is not indexed yet.",
            },
      });
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeCapturePlanFile(plan, fullPath);
    const syncResults = await defaultSyncService.syncFiles(
      collection,
      this.store,
      [plan.relPath],
      withContentTypeRules(
        {
          runUpdateCmd: false,
          gitPull: false,
        },
        this.config
      )
    );
    const syncResult = syncResults[0];
    const docResult = await this.store.getDocument(
      collection.name,
      plan.relPath
    );
    const docid = docResult.ok ? docResult.value?.docid : undefined;
    return buildCaptureReceipt({
      plan,
      absPath: fullPath,
      docid: syncResult?.docid ?? docid,
      sync:
        syncResult?.status === "error"
          ? {
              status: "failed",
              error:
                syncResult.errorMessage ??
                syncResult.errorCode ??
                "Unknown sync error",
            }
          : { status: "completed" },
    });
  }

  async createFolder(
    options: GnoCreateFolderOptions
  ): Promise<GnoCreateFolderResult> {
    this.assertOpen();
    const collection = this.getCollections(options.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${options.collection}`
      );
    }

    const folderPath = planCreateFolder({
      parentPath: options.parentPath,
      name: options.name,
    });
    const fullPath = `${collection.path}/${folderPath}`;
    await createFolderPath(fullPath);

    return {
      collection: collection.name,
      folderPath,
      path: fullPath,
    };
  }

  async renameNote(
    options: GnoRenameNoteOptions
  ): Promise<GnoRefactorNoteResult> {
    this.assertOpen();
    const doc = await getDocumentByRef(
      this.store,
      this.config,
      options.ref,
      {}
    );
    const stored = await this.store.getDocumentByUri(doc.uri);
    if (!stored.ok || !stored.value) {
      throw sdkError("NOT_FOUND", "Document not found");
    }
    const storedDoc = stored.value;
    const collection = this.getCollections(storedDoc.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${storedDoc.collection}`
      );
    }
    const plan = planRenameRefactor({
      collection: collection.name,
      currentRelPath: storedDoc.relPath,
      nextName: options.name,
    });
    const currentPath = `${collection.path}/${storedDoc.relPath}`;
    const nextPath = `${collection.path}/${plan.nextRelPath}`;
    await renameFilePath(currentPath, nextPath);
    await defaultSyncService.syncCollection(
      collection,
      this.store,
      withContentTypeRules({ runUpdateCmd: false }, this.config)
    );
    const linksResult = await this.store.getLinksForDoc(storedDoc.id);
    const backlinksResult = await this.store.getBacklinksForDoc(storedDoc.id);
    if (!linksResult.ok || !backlinksResult.ok) {
      throw sdkError("STORE", "Failed to compute refactor warnings");
    }
    return {
      uri: plan.nextUri,
      path: nextPath,
      relPath: plan.nextRelPath,
      warnings: buildRefactorWarnings(
        {
          backlinks: backlinksResult.value.length,
          wikiLinks: linksResult.value.filter(
            (entry) => entry.linkType === "wiki"
          ).length,
          markdownLinks: linksResult.value.filter(
            (entry) => entry.linkType === "markdown"
          ).length,
        },
        { filenameChanged: true }
      ).warnings,
    };
  }

  async moveNote(options: GnoMoveNoteOptions): Promise<GnoRefactorNoteResult> {
    this.assertOpen();
    const doc = await getDocumentByRef(
      this.store,
      this.config,
      options.ref,
      {}
    );
    const stored = await this.store.getDocumentByUri(doc.uri);
    if (!stored.ok || !stored.value) {
      throw sdkError("NOT_FOUND", "Document not found");
    }
    const storedDoc = stored.value;
    const collection = this.getCollections(storedDoc.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${storedDoc.collection}`
      );
    }
    const plan = planMoveRefactor({
      collection: collection.name,
      currentRelPath: storedDoc.relPath,
      folderPath: options.folderPath,
      nextName: options.name,
    });
    const currentPath = `${collection.path}/${storedDoc.relPath}`;
    const nextPath = `${collection.path}/${plan.nextRelPath}`;
    await mkdir(dirname(nextPath), { recursive: true });
    await renameFilePath(currentPath, nextPath);
    await defaultSyncService.syncCollection(
      collection,
      this.store,
      withContentTypeRules({ runUpdateCmd: false }, this.config)
    );
    const linksResult = await this.store.getLinksForDoc(storedDoc.id);
    const backlinksResult = await this.store.getBacklinksForDoc(storedDoc.id);
    if (!linksResult.ok || !backlinksResult.ok) {
      throw sdkError("STORE", "Failed to compute refactor warnings");
    }
    return {
      uri: plan.nextUri,
      path: nextPath,
      relPath: plan.nextRelPath,
      warnings: buildRefactorWarnings(
        {
          backlinks: backlinksResult.value.length,
          wikiLinks: linksResult.value.filter(
            (entry) => entry.linkType === "wiki"
          ).length,
          markdownLinks: linksResult.value.filter(
            (entry) => entry.linkType === "markdown"
          ).length,
        },
        {
          folderChanged: true,
          filenameChanged: Boolean(options.name),
        }
      ).warnings,
    };
  }

  async duplicateNote(
    options: GnoDuplicateNoteOptions
  ): Promise<GnoRefactorNoteResult> {
    this.assertOpen();
    const doc = await getDocumentByRef(
      this.store,
      this.config,
      options.ref,
      {}
    );
    const stored = await this.store.getDocumentByUri(doc.uri);
    if (!stored.ok || !stored.value) {
      throw sdkError("NOT_FOUND", "Document not found");
    }
    const storedDoc = stored.value;
    const collection = this.getCollections(storedDoc.collection)[0];
    if (!collection) {
      throw sdkError(
        "VALIDATION",
        `Collection not found: ${storedDoc.collection}`
      );
    }
    const docsResult = await this.store.listDocuments(collection.name);
    if (!docsResult.ok) {
      throw sdkError("STORE", docsResult.error.message, {
        cause: docsResult.error.cause,
      });
    }
    const plan = planDuplicateRefactor({
      collection: collection.name,
      currentRelPath: storedDoc.relPath,
      folderPath: options.folderPath,
      nextName: options.name,
      existingRelPaths: docsResult.value.map((entry) => entry.relPath),
    });
    const currentPath = `${collection.path}/${storedDoc.relPath}`;
    const nextPath = `${collection.path}/${plan.nextRelPath}`;
    await mkdir(dirname(nextPath), { recursive: true });
    await copyFilePath(currentPath, nextPath);
    await defaultSyncService.syncCollection(
      collection,
      this.store,
      withContentTypeRules({ runUpdateCmd: false }, this.config)
    );
    const linksResult = await this.store.getLinksForDoc(storedDoc.id);
    const backlinksResult = await this.store.getBacklinksForDoc(storedDoc.id);
    if (!linksResult.ok || !backlinksResult.ok) {
      throw sdkError("STORE", "Failed to compute refactor warnings");
    }
    return {
      uri: plan.nextUri,
      path: nextPath,
      relPath: plan.nextRelPath,
      warnings: buildRefactorWarnings({
        backlinks: backlinksResult.value.length,
        wikiLinks: linksResult.value.filter(
          (entry) => entry.linkType === "wiki"
        ).length,
        markdownLinks: linksResult.value.filter(
          (entry) => entry.linkType === "markdown"
        ).length,
      }).warnings,
    };
  }

  async getSections(ref: string) {
    this.assertOpen();
    const document = await getDocumentByRef(this.store, this.config, ref, {});
    return extractSections(document.content);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.store.close();
    await this.llm.dispose();
  }
}

export async function createGnoClient(
  options: GnoClientInitOptions = {}
): Promise<GnoClient> {
  if (options.indexName !== undefined && !isValidIndexName(options.indexName)) {
    throw sdkError(
      "VALIDATION",
      `Invalid index name: ${INDEX_NAME_REQUIREMENTS}.`
    );
  }
  const state = await resolveClientState(options);
  return new GnoClientImpl(state);
}
