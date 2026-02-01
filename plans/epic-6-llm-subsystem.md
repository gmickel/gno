# EPIC 6: LLM Subsystem (node-llama-cpp) and Model UX

**Status:** Planning
**Priority:** P1
**Type:** Feature
**Depends On:** EPIC 4 (converters), EPIC 5 (ingestion/chunking)
**Blocking:** EPIC 7 (embeddings), EPIC 8 (search pipelines)

---

## Overview

Implement local LLM inference via node-llama-cpp with GGUF models. No separate server process. Supports embeddings, generation (query expansion/HyDE), and cross-encoder reranking. Config-driven model presets with graceful fallback when models unavailable.

## Problem Statement

GNO needs local inference for:

- **Embeddings**: Vector semantic search (EPIC 7)
- **Generation**: Query expansion, HyDE synthesis (EPIC 8)
- **Reranking**: Cross-encoder scoring (EPIC 8)

Must be:

- Zero external runtime (no Ollama, no Python)
- Auto-configured for hardware (Metal/CUDA/CPU)
- Deterministic (temp=0, versioned prompts, cached results)
- Graceful degradation when models missing

---

## Technical Approach

### Architecture

Follow existing ports/adapters pattern (per converter subsystem):

```
src/llm/
  types.ts              # Port interfaces
  errors.ts             # LLM-specific errors
  cache.ts              # Model cache resolver (hf: URIs)
  registry.ts           # Model preset registry
  nodeLlamaCpp/
    adapter.ts          # Main adapter
    embedding.ts        # EmbeddingPort impl
    generation.ts       # GenerationPort impl
    rerank.ts           # RerankPort impl
    lifecycle.ts        # Model load/dispose
    versions.ts         # Model version tracking
```

### Port Interfaces

```typescript
// src/llm/types.ts
export type LlmResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LlmError };

export type EmbeddingPort = {
  readonly modelUri: string;
  embed(text: string): Promise<LlmResult<number[]>>;
  embedBatch(texts: string[]): Promise<LlmResult<number[][]>>;
  dimensions(): number;
  dispose(): Promise<void>;
};

export type GenerationPort = {
  readonly modelUri: string;
  generate(prompt: string, params: GenParams): Promise<LlmResult<string>>;
  dispose(): Promise<void>;
};

export type RerankPort = {
  readonly modelUri: string;
  rerank(query: string, documents: string[]): Promise<LlmResult<RerankScore[]>>;
  dispose(): Promise<void>;
};
```

### Model Lifecycle Strategy

Per node-llama-cpp best practices:

- **Lazy loading**: Load model on first use
- **Keep warm**: Cache loaded model in memory (configurable TTL)
- **Explicit dispose**: `await model.dispose()` for MCP cleanup
- **Auto-config**: Omit gpuLayers/contextSize, let library optimize

---

## Implementation Phases

> **Phasing note (from review)**: Reordered to ensure CLI/doctor use shared registry+cache primitives.

### Phase 1: Types, Errors, Config (T6.1 + T6.2)

#### 1.1 LLM Types and Errors

**File:** `src/llm/types.ts`

```typescript
export type ModelType = "embed" | "rerank" | "gen";

export type ModelUri = string; // Format: hf:org/repo/file.gguf

export type ModelPreset = {
  id: string;
  name: string;
  embed: ModelUri;
  rerank: ModelUri;
  gen: ModelUri;
};

export type ModelCacheEntry = {
  uri: ModelUri;
  type: ModelType;
  path: string;
  size: number;
  checksum: string;
  cachedAt: string;
};
```

**File:** `src/llm/errors.ts`

```typescript
export type LlmErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_LOAD_FAILED"
  | "MODEL_CORRUPTED"
  | "INFERENCE_FAILED"
  | "TIMEOUT"
  | "OUT_OF_MEMORY";

export type LlmError = {
  code: LlmErrorCode;
  message: string;
  modelUri?: string;
  retryable: boolean;
  cause?: unknown;
};
```

#### 1.2 Config Schema Extension

**File:** `src/config/types.ts` (extend existing)

```typescript
const ModelPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  embed: z.string(), // hf: URI
  rerank: z.string(),
  gen: z.string(),
});

const ModelConfigSchema = z.object({
  activePreset: z.string().default("multilingual"),
  presets: z.array(ModelPresetSchema).default([
    {
      id: "multilingual",
      name: "Multilingual (BGE + Qwen)",
      embed: "hf:BAAI/bge-m3-gguf/bge-m3-q4_k_m.gguf",
      rerank: "hf:BAAI/bge-reranker-v2-m3-gguf/bge-reranker-v2-m3-q4_k_m.gguf",
      gen: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
    {
      id: "qwen",
      name: "Qwen Family",
      embed:
        "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/qwen3-embedding-0.6b-q4_k_m.gguf",
      rerank:
        "hf:Qwen/Qwen3-Reranker-0.6B-GGUF/qwen3-reranker-0.6b-q4_k_m.gguf",
      gen: "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
  ]),
  loadTimeout: z.number().default(60000), // ms
  inferenceTimeout: z.number().default(30000), // ms
  warmModelTtl: z.number().default(300000), // 5 min
});
```

#### 1.3 Preset Registry

**File:** `src/llm/registry.ts`

```typescript
import type { Config, ModelPreset } from "../config/types";
import type { LlmError } from "./errors";
import { presetNotFoundError } from "./errors";

export function getActivePreset(config: Config): ModelPreset {
  const presetId = config.models?.activePreset ?? "multilingual";
  const preset = config.models?.presets?.find((p) => p.id === presetId);

  if (!preset) {
    // Fallback to first preset or throw
    const fallback = config.models?.presets?.[0];
    if (fallback) return fallback;
    throw new Error(`No model preset found: ${presetId}`);
  }

  return preset;
}

export function resolveModelUri(
  config: Config,
  type: "embed" | "rerank" | "gen",
  override?: string
): string {
  if (override) return override;
  const preset = getActivePreset(config);
  return preset[type];
}

export function listPresets(config: Config): ModelPreset[] {
  return config.models?.presets ?? [];
}
```

#### 1.4 Model Lifecycle Manager

**File:** `src/llm/nodeLlamaCpp/lifecycle.ts`

```typescript
export class ModelManager {
  private llama: Llama | null = null;
  private models: Map<string, LoadedModel> = new Map();
  private disposalTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  async getLlama(): Promise<Llama> {
    if (!this.llama) {
      const { getLlama } = await import("node-llama-cpp");
      this.llama = await getLlama();
    }
    return this.llama;
  }

  async loadModel(uri: string, type: ModelType): Promise<LoadedModel> {
    const cached = this.models.get(uri);
    if (cached) {
      this.resetDisposalTimer(uri);
      return cached;
    }
    // Load model, cache, set disposal timer
  }

  async dispose(uri?: string): Promise<void> {
    // Dispose specific model or all
  }

  async disposeAll(): Promise<void> {
    for (const [uri] of this.models) {
      await this.dispose(uri);
    }
    this.llama = null;
  }
}
```

### Phase 2: Model Cache Resolver (T6.3)

#### 2.1 HF URI Parser

**File:** `src/llm/cache.ts`

```typescript
export type ParsedModelUri = {
  scheme: "hf" | "file";
  org?: string;
  repo?: string;
  file: string;
  quantization?: string;
};

export function parseModelUri(uri: string): Result<ParsedModelUri, string> {
  if (uri.startsWith("hf:")) {
    // hf:org/repo/file.gguf or hf:org/repo:Q4_K_M
    const match = uri.match(/^hf:([^/]+)\/([^/:]+)(?:\/([^:]+)|:(\w+))?$/);
    if (!match) return { ok: false, error: "Invalid hf: URI format" };
    // ...
  }
  if (uri.startsWith("file:") || uri.startsWith("/")) {
    return {
      ok: true,
      value: { scheme: "file", file: uri.replace("file:", "") },
    };
  }
  return { ok: false, error: `Unknown URI scheme: ${uri}` };
}
```

#### 2.2 Model Cache Manager

**File:** `src/llm/cache.ts`

```typescript
export class ModelCache {
  constructor(private cacheDir: string) {}

  async resolve(uri: string): Promise<Result<string, LlmError>> {
    const parsed = parseModelUri(uri);
    if (!parsed.ok)
      return { ok: false, error: modelNotFoundError(uri, parsed.error) };

    if (parsed.value.scheme === "file") {
      return this.resolveLocalFile(parsed.value.file);
    }

    const cachedPath = await this.getCachedPath(uri);
    if (cachedPath) return { ok: true, value: cachedPath };

    return { ok: false, error: modelNotFoundError(uri, "Not cached") };
  }

  async download(
    uri: string,
    onProgress?: ProgressCallback
  ): Promise<Result<string, LlmError>> {
    const { resolveModelFile } = await import("node-llama-cpp");
    try {
      const path = await resolveModelFile(
        uri.replace("hf:", ""),
        this.cacheDir
      );
      await this.updateManifest(uri, path);
      return { ok: true, value: path };
    } catch (e) {
      return { ok: false, error: downloadFailedError(uri, e) };
    }
  }

  async list(): Promise<ModelCacheEntry[]> {
    // Read manifest.json from cacheDir
  }

  async clear(type?: ModelType): Promise<void> {
    // Delete models from cache
  }
}
```

### Phase 3: Port Implementations

#### 3.1 Embedding Port

**File:** `src/llm/nodeLlamaCpp/embedding.ts`

```typescript
export class NodeLlamaCppEmbedding implements EmbeddingPort {
  private context: LlamaEmbeddingContext | null = null;

  constructor(
    private manager: ModelManager,
    readonly modelUri: string,
    private config: EmbeddingConfig
  ) {}

  async embed(text: string): Promise<LlmResult<number[]>> {
    const ctx = await this.getContext();
    if (!ctx.ok) return ctx;

    try {
      const embedding = await ctx.value.getEmbeddingFor(text);
      return { ok: true, value: Array.from(embedding.vector) };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  async embedBatch(texts: string[]): Promise<LlmResult<number[][]>> {
    const ctx = await this.getContext();
    if (!ctx.ok) return ctx;

    const results = await Promise.all(
      texts.map(async (text) => {
        const emb = await ctx.value.getEmbeddingFor(text);
        return Array.from(emb.vector);
      })
    );
    return { ok: true, value: results };
  }

  private dims: number | null = null;

  dimensions(): number {
    if (this.dims === null) {
      throw new Error("Call embed() first to initialize dimensions");
    }
    return this.dims;
  }

  // Called after first embedding to cache dimension
  private setDimensions(vector: number[]): void {
    if (this.dims === null) {
      this.dims = vector.length;
    }
  }

  async dispose(): Promise<void> {
    this.context = null;
  }

  private async getContext(): Promise<LlmResult<LlamaEmbeddingContext>> {
    if (this.context) return { ok: true, value: this.context };

    const model = await this.manager.loadModel(this.modelUri, "embed");
    if (!model.ok) return model;

    this.context = await model.value.model.createEmbeddingContext();
    return { ok: true, value: this.context };
  }
}
```

#### 3.2 Generation Port

**File:** `src/llm/nodeLlamaCpp/generation.ts`

```typescript
export class NodeLlamaCppGeneration implements GenerationPort {
  async generate(
    prompt: string,
    params: GenParams
  ): Promise<LlmResult<string>> {
    const model = await this.manager.loadModel(this.modelUri, "gen");
    if (!model.ok) return model;

    const context = await model.value.model.createContext();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
    });

    try {
      const response = await session.prompt(prompt, {
        temperature: params.temperature ?? 0,
        seed: params.seed ?? 42,
        maxTokens: params.maxTokens ?? 256,
      });
      return { ok: true, value: response };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }
}
```

#### 3.3 Rerank Port

**File:** `src/llm/nodeLlamaCpp/rerank.ts`

```typescript
export class NodeLlamaCppRerank implements RerankPort {
  async rerank(
    query: string,
    documents: string[]
  ): Promise<LlmResult<RerankScore[]>> {
    const model = await this.manager.loadModel(this.modelUri, "rerank");
    if (!model.ok) return model;

    const context = await model.value.model.createRankingContext();

    try {
      const ranked = await context.rankAndSort(query, documents);
      return {
        ok: true,
        value: ranked.map((r, i) => ({
          index: documents.indexOf(r.document),
          score: r.score,
          rank: i + 1,
        })),
      };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }
}
```

### Phase 4: CLI Commands (T6.3)

#### 4.1 gno models list

**File:** `src/cli/commands/models/list.ts`

```typescript
export type ModelsListResult = {
  embed: ModelStatus;
  rerank: ModelStatus;
  gen: ModelStatus;
  cacheDir: string;
  totalSize: number;
};

export async function modelsListCommand(
  opts: ModelsListOptions
): Promise<ModelsListResult> {
  const config = await loadConfig(opts.configPath);
  const preset = getActivePreset(config);
  const cache = new ModelCache(getModelsCachePath());

  return {
    embed: await getModelStatus(cache, preset.embed),
    rerank: await getModelStatus(cache, preset.rerank),
    gen: await getModelStatus(cache, preset.gen),
    cacheDir: cache.dir,
    totalSize: await cache.totalSize(),
  };
}
```

#### 4.2 gno models pull

**File:** `src/cli/commands/models/pull.ts`

```typescript
export async function modelsPullCommand(
  opts: ModelsPullOptions
): Promise<ModelsPullResult> {
  const config = await loadConfig(opts.configPath);
  const preset = getActivePreset(config);
  const cache = new ModelCache(getModelsCachePath());

  const types: ModelType[] = opts.all
    ? ["embed", "rerank", "gen"]
    : [
        opts.embed && "embed",
        opts.rerank && "rerank",
        opts.gen && "gen",
      ].filter(Boolean);

  if (types.length === 0) {
    types.push("embed", "rerank", "gen"); // Default: pull all
  }

  const results: ModelPullResult[] = [];
  for (const type of types) {
    const uri = preset[type];
    const result = await cache.download(uri, (progress) => {
      if (!opts.quiet) {
        renderProgress(type, progress);
      }
    });
    results.push({ type, uri, ...result });
  }

  return { results, failed: results.filter((r) => !r.ok).length };
}
```

#### 4.3 gno models clear

**File:** `src/cli/commands/models/clear.ts`

```typescript
export async function modelsClearCommand(
  opts: ModelsClearOptions
): Promise<void> {
  const cache = new ModelCache(getModelsCachePath());

  if (!opts.yes) {
    const confirm = await promptConfirm("Delete cached models?");
    if (!confirm) return;
  }

  const types = opts.all
    ? undefined
    : [
        opts.embed && "embed",
        opts.rerank && "rerank",
        opts.gen && "gen",
      ].filter(Boolean);

  await cache.clear(types);
}
```

#### 4.4 gno models path

**File:** `src/cli/commands/models/path.ts`

```typescript
export async function modelsPathCommand(
  opts: ModelsPathOptions
): Promise<string> {
  return getModelsCachePath();
}
```

### Phase 5: Doctor Extension (T6.4)

**File:** `src/cli/commands/doctor.ts` (extend)

```typescript
async function checkModels(config: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const cache = new ModelCache(getModelsCachePath());
  const preset = getActivePreset(config);

  for (const type of ["embed", "rerank", "gen"] as const) {
    const uri = preset[type];
    const cached = await cache.isCached(uri);

    checks.push({
      name: `${type}-model`,
      status: cached ? "ok" : "warn",
      message: cached
        ? `${type} model cached`
        : `${type} model not cached, run gno models pull --${type}`,
    });
  }

  // Check node-llama-cpp compatibility
  try {
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    checks.push({
      name: "node-llama-cpp",
      status: "ok",
      message: "node-llama-cpp loaded successfully",
    });
  } catch (e) {
    checks.push({
      name: "node-llama-cpp",
      status: "error",
      message: `node-llama-cpp failed: ${e.message}`,
    });
  }

  return checks;
}
```

---

## Acceptance Criteria

### Functional Requirements

- [ ] `gno models list` shows all configured models with cache status
- [ ] `gno models pull --all` downloads all models with progress
- [ ] `gno models pull --embed` downloads only embedding model
- [ ] `gno models clear` removes cached models (with confirmation)
- [ ] `gno models path` prints cache directory
- [ ] `gno doctor` reports model availability and node-llama-cpp status
- [ ] Embedding port generates correct-dimension vectors
- [ ] Generation port produces deterministic output (temp=0)
- [ ] Rerank port returns normalized scores

### Non-Functional Requirements

- [ ] Model loading < 10s on first use
- [ ] Warm model inference < 100ms for embeddings
- [ ] Models auto-unload after 5min idle (configurable)
- [ ] No memory leaks across repeated operations
- [ ] Graceful degradation when models unavailable

### Quality Gates

- [ ] Unit tests for URI parsing, cache management
- [ ] Integration tests with real model (CI skip via mock)
- [ ] Contract tests for `models list` JSON schema
- [ ] `bun test` passes
- [ ] `bun run lint` passes

---

## Dependencies & Prerequisites

### External

- `node-llama-cpp` ^3.x (add to package.json)
- GGUF models from Hugging Face

### Internal

- EPIC 4: Converter subsystem (reference for adapter pattern)
- EPIC 5: Chunking (provides texts for embedding)
- `src/config/types.ts`: Extend with model config
- `src/app/constants.ts`: Model cache path helper (exists)

---

## Risk Analysis & Mitigation

| Risk                                       | Impact | Mitigation                                     |
| ------------------------------------------ | ------ | ---------------------------------------------- |
| Native compilation fails on some platforms | High   | `gno doctor` diagnoses; document rebuild steps |
| Model files are multi-GB                   | Medium | Progress bars; resume downloads                |
| node-llama-cpp API changes                 | Medium | Pin version; adapter isolation                 |
| Out of memory on small machines            | High   | Auto-config; smaller quantizations             |
| Model version drift breaks determinism     | Medium | Pin URIs to commits in presets                 |

---

## File Changes Summary

### New Files

| Path                                          | Description                         |
| --------------------------------------------- | ----------------------------------- |
| `src/llm/types.ts`                            | Port interfaces, model types        |
| `src/llm/errors.ts`                           | LlmError helpers                    |
| `src/llm/cache.ts`                            | Model cache resolver                |
| `src/llm/registry.ts`                         | Preset registry + getActivePreset() |
| `src/llm/index.ts`                            | Module exports (front door)         |
| `src/llm/nodeLlamaCpp/adapter.ts`             | Main adapter                        |
| `src/llm/nodeLlamaCpp/embedding.ts`           | EmbeddingPort impl                  |
| `src/llm/nodeLlamaCpp/generation.ts`          | GenerationPort impl                 |
| `src/llm/nodeLlamaCpp/rerank.ts`              | RerankPort impl                     |
| `src/llm/nodeLlamaCpp/lifecycle.ts`           | Model loading                       |
| `src/llm/nodeLlamaCpp/versions.ts`            | Version tracking                    |
| `src/cli/commands/models/list.ts`             | `gno models list`                   |
| `src/cli/commands/models/pull.ts`             | `gno models pull`                   |
| `src/cli/commands/models/clear.ts`            | `gno models clear`                  |
| `src/cli/commands/models/path.ts`             | `gno models path`                   |
| `src/cli/commands/models/index.ts`            | Command exports                     |
| `spec/output-schemas/models-list.schema.json` | JSON schema                         |
| `spec/output-schemas/doctor.schema.json`      | JSON schema                         |
| `test/llm/cache.test.ts`                      | Cache unit tests                    |
| `test/llm/uri.test.ts`                        | URI parsing tests                   |
| `test/spec/schemas/models-list.test.ts`       | Contract tests                      |

### Modified Files

| Path                         | Change                          |
| ---------------------------- | ------------------------------- |
| `package.json`               | Add `node-llama-cpp` dependency |
| `src/config/types.ts`        | Add `models` config section     |
| `src/config/defaults.ts`     | Add model preset defaults       |
| `src/cli/commands/doctor.ts` | Extend with model checks        |
| `src/cli/index.ts`           | Register models subcommands     |
| `spec/cli.md`                | Add `--force` to models pull    |

---

## Testing Strategy

### Unit Tests

```typescript
// test/llm/uri.test.ts
describe("parseModelUri", () => {
  test("parses hf: with org/repo/file", () => {
    const result = parseModelUri("hf:BAAI/bge-m3-gguf/bge-m3-q4_k_m.gguf");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      scheme: "hf",
      org: "BAAI",
      repo: "bge-m3-gguf",
      file: "bge-m3-q4_k_m.gguf",
    });
  });

  test("parses hf: with quantization shorthand", () => {
    const result = parseModelUri("hf:BAAI/bge-m3-gguf:Q4_K_M");
    expect(result.ok).toBe(true);
  });

  test("rejects invalid URI", () => {
    const result = parseModelUri("invalid");
    expect(result.ok).toBe(false);
  });
});
```

### Integration Tests (CI-safe with mocks)

```typescript
// test/llm/embedding.integration.test.ts
describe.skipIf(!process.env.TEST_LLM)("EmbeddingPort", () => {
  test("generates embedding vector", async () => {
    const port = await createEmbeddingPort();
    const result = await port.embed("Hello world");
    expect(result.ok).toBe(true);
    expect(result.value).toHaveLength(1024);
  });
});
```

### Contract Tests

```typescript
// test/spec/schemas/models-list.test.ts
import Ajv from "ajv";
import schema from "../../../spec/output-schemas/models-list.schema.json";

test("modelsListCommand output matches schema", async () => {
  const result = await modelsListCommand({ json: true });
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  expect(validate(result)).toBe(true);
});
```

---

## Design Decisions (from review)

### D1: First-run download behavior

**Decision**: Commands requiring models fail gracefully with instructions. No auto-download.

```
Error: Embedding model not cached

Run: gno models pull --embed
Then retry your command.
```

### D2: Default `pull` behavior

**Decision**: `gno models pull` (no flags) = `--all` (download all models)

### D3: Model re-download policy

**Decision**: Skip if checksum matches. Add `--force` flag to re-download. Update spec/cli.md.

### D4: Model unloading policy

**Decision**: Keep warm for 5 min (configurable `warmModelTtl`), then dispose.

### D5: Scope of `llm_cache` table

**Decision**:

- **Model artifacts**: Filesystem manifest (`manifest.json` in cache dir)
- **Inference result caching**: SQLite `llm_cache` table (for EPIC 8 query expansion/HyDE caching)
- EPIC 6 only implements model artifact caching. EPIC 8 adds inference result caching.

### D6: `models list` output fields

**Decision**: Update spec to include `cacheDir` and `totalSize`. Add schema to `spec/output-schemas/models-list.schema.json`.

### D7: Determinism implementation

**Decision**: Add versioned prompt templates in EPIC 8 (query expansion). EPIC 6 provides:

- `temperature: 0` default in GenParams
- `seed: 42` default in GenParams
- Port interfaces that enforce these defaults

---

## References

### Internal

- PRD §11 (lines 726-800): Model strategy
- PRD §22 EPIC 6 (lines 1439-1448): Task breakdown
- `spec/cli.md:685-753`: Model commands spec
- `spec/db/schema.sql:177-187`: llm_cache table
- `src/converters/`: Adapter pattern reference
- `src/config/types.ts`: Config schema reference

### External

- [node-llama-cpp v3 docs](https://node-llama-cpp.withcat.ai/)
- [node-llama-cpp embedding guide](https://node-llama-cpp.withcat.ai/guide/embedding)
- [GGUF format on HuggingFace](https://huggingface.co/docs/hub/en/gguf)
- [BGE-M3 model](https://huggingface.co/BAAI/bge-m3)

---

## Review Feedback Applied

**Reviewer**: RepoPrompt (plan mode)

### Changes Made

1. **Added `src/llm/registry.ts`** with concrete `getActivePreset()`, `resolveModelUri()`, `listPresets()` implementations (Phase 1.3)

2. **Fixed timer typing** in lifecycle: `ReturnType<typeof setTimeout>` instead of `Timer`

3. **Fixed hardcoded embedding dimensions**: Changed to lazy initialization from first embedding result

4. **Clarified llm_cache scope** (D5): Model artifacts in filesystem, inference caching in SQLite for EPIC 8

5. **Updated spec alignment** (D6): Will add `cacheDir`, `totalSize` to spec and create schema

6. **Added `--force` flag** (D3): Will update spec/cli.md

7. **Added `src/llm/index.ts`** to file list for module exports

8. **Documented determinism approach** (D7): temp=0, seed=42 defaults; versioned prompts deferred to EPIC 8

### Remaining Considerations (for implementation)

- **Concurrency**: Add mutex/queue if node-llama-cpp objects aren't thread-safe
- **URI format validation**: Confirm node-llama-cpp's exact HF URI expectations
- **Graceful degradation helpers**: `modelNotCachedError()` with suggestion commands for EPIC 7/8 integration
