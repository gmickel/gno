/** Private compatibility shapes pinned to node-llama-cpp 3.19.1. */
export interface SimulatorDisposable {
  dispose(): void | Promise<void>;
}
export interface SimulatorGuard {
  createPreventDisposalHandle(): SimulatorDisposable;
  acquireDisposeLock(): Promise<void>;
}
export interface SimulatorMemory {
  cpuRam: number;
  gpuVram: number;
}
export interface SimulatorModel {
  init(source?: unknown): Promise<boolean>;
  getMemoryBreakdown(): SimulatorMemory;
  dispose(): Promise<void>;
}
export interface SimulatorContext {
  init(): Promise<boolean>;
  getMemoryBreakdown(): SimulatorMemory;
  dispose(): Promise<void>;
}
export interface SimulatorBackend {
  gpu: string | false;
  supportsMmap: boolean;
  _memoryLock: object;
  _backendDisposeGuard: SimulatorGuard;
  _bindings: {
    AddonModel: new (
      source: string,
      options: Record<string, unknown>
    ) => SimulatorModel;
    AddonContext: new (
      model: SimulatorModel,
      options: Record<string, unknown>
    ) => SimulatorContext;
  };
  onDispose: {
    createListener(callback: () => void | Promise<void>): SimulatorDisposable;
  };
  _createLogLevelOverride(level: string): () => void;
  _shouldLog(level: string): boolean;
  _log(level: string, message: string): void;
}
export interface SimulatorCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): unknown;
  delete(key: string): unknown;
  clear(): void;
  values(): IterableIterator<T>;
}
export interface SimulatorDependencies {
  DisposeGuard: new (parents: SimulatorGuard[]) => SimulatorGuard;
  LruCache: new <T>(
    size: number,
    options?: { onDelete(key: string, value: T): Promise<void> }
  ) => SimulatorCache<T>;
  acquireLock(keys: unknown[]): Promise<SimulatorDisposable>;
  needInitLock(gpu: string | false): boolean;
  addonInit: string;
  debug: string;
  error: string;
  f16: number;
  bytes(value: number): string;
}
export interface SimulatorModelOptions {
  modelSource: unknown;
  gpuLayers: number;
  useMmap?: boolean;
}
export interface SimulatorContextOptions extends SimulatorModelOptions {
  contextSize: number;
  batchSize: number;
  sequences: number;
  isEmbeddingContext?: boolean;
  flashAttention?: boolean | "auto";
  swaFullCache?: boolean;
  kvCacheKeyType?: number;
  kvCacheValueType?: number;
}
