/**
 * Source content readers for `any` (legacy) and `local` (Darwin-guarded) modes.
 *
 * @module src/ingestion/source-availability/readers
 */

import {
  classifyGuardedReadErrno,
  type DarwinFileIoPort,
  type DarwinIoPolicyPort,
  guardedOpenFlags,
  loadDarwinIo,
  withNoMaterializePolicy,
} from "./darwin-io";
import {
  classifyDarwinFileProviderPath,
  type DarwinFileProviderPathSupport,
} from "./darwin-path";
import {
  type SourceAvailabilityMode,
  type SourceContentReaderPort,
  type SourceReadResult,
  sourceAvailabilityMessage,
} from "./types";

const READ_CHUNK_BYTES = 64 * 1024;
/** Injectable deps for unit tests; production uses loadDarwinIo(). */
export type LocalReaderDeps = {
  platform?: string;
  policy?: DarwinIoPolicyPort | null;
  file?: DarwinFileIoPort | null;
  pathSupport?: (absPath: string) => DarwinFileProviderPathSupport;
  /**
   * Optional pre-open flag probe. When provided and returns a non-null
   * outcome, the reader fails closed without materializing content.
   * Production leaves this unset (content-boundary policy is the guard).
   */
  safetyProbe?: (absPath: string) => SourceReadResult | null;
};

/** Legacy path: Bun.file byte reads (current ingestion behavior). */
export class AnySourceContentReader implements SourceContentReaderPort {
  readonly mode: SourceAvailabilityMode = "any";

  async readAll(
    absPath: string,
    _expectedSize?: number
  ): Promise<SourceReadResult> {
    try {
      const bytes = await Bun.file(absPath).bytes();
      return { ok: true, bytes };
    } catch (error) {
      return mapNodeLikeReadError(error);
    }
  }
}

/**
 * Local mode reader. On Darwin, establishes no-materialization I/O policy and
 * reads via native open/read so EDEADLK maps to cloud-placeholder skip.
 * Non-Darwin and policy/FFI failures fail closed with distinct codes.
 */
export class LocalSourceContentReader implements SourceContentReaderPort {
  readonly mode: SourceAvailabilityMode = "local";
  private readonly platform: string;
  private readonly policy: DarwinIoPolicyPort | null;
  private readonly file: DarwinFileIoPort | null;
  private readonly safetyProbe?: (absPath: string) => SourceReadResult | null;
  private readonly pathSupport: (
    absPath: string
  ) => DarwinFileProviderPathSupport;

  constructor(deps: LocalReaderDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    if (deps.policy !== undefined || deps.file !== undefined) {
      this.policy = deps.policy ?? null;
      this.file = deps.file ?? null;
    } else if (this.platform === "darwin") {
      const loaded = loadDarwinIo();
      this.policy = loaded?.policy ?? null;
      this.file = loaded?.file ?? null;
    } else {
      this.policy = null;
      this.file = null;
    }
    this.safetyProbe = deps.safetyProbe;
    this.pathSupport = deps.pathSupport ?? classifyDarwinFileProviderPath;
  }

  async readAll(
    absPath: string,
    expectedSize?: number
  ): Promise<SourceReadResult> {
    if (this.platform !== "darwin") {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_UNSUPPORTED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNSUPPORTED",
          `platform=${this.platform}`
        ),
      };
    }
    if (!this.policy || !this.file) {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_POLICY_FAILED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_POLICY_FAILED",
          "darwin_io_unavailable"
        ),
      };
    }

    const pathSupport = this.pathSupport(absPath);
    if (pathSupport === "unsupported") {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_UNSUPPORTED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNSUPPORTED",
          "path is outside the physically evidenced macOS File Provider layouts"
        ),
      };
    }
    if (pathSupport === "unknown") {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNKNOWN",
          "path support could not be established"
        ),
      };
    }

    if (this.safetyProbe) {
      const probed = this.safetyProbe(absPath);
      if (probed !== null) {
        return probed;
      }
    }

    const policy = this.policy;
    const file = this.file;
    let wrapped: ReturnType<typeof withNoMaterializePolicy<SourceReadResult>>;
    try {
      wrapped = withNoMaterializePolicy(
        () => readAllNative(absPath, file, expectedSize),
        policy
      );
    } catch (error) {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_UNKNOWN",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_UNKNOWN",
          error instanceof Error ? error.message : "native_read_failed"
        ),
      };
    }
    if (!wrapped.ok) {
      return {
        ok: false,
        code: "SOURCE_AVAILABILITY_POLICY_FAILED",
        message: sourceAvailabilityMessage(
          "SOURCE_AVAILABILITY_POLICY_FAILED",
          wrapped.error
        ),
      };
    }
    return wrapped.value;
  }
}

function readAllNative(
  absPath: string,
  file: DarwinFileIoPort,
  expectedSize?: number
): SourceReadResult {
  const fd = file.open(absPath, guardedOpenFlags());
  if (fd < 0) {
    return mapErrno(file.readErrno(), 0);
  }
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const buf = new Uint8Array(READ_CHUNK_BYTES);
    for (;;) {
      const n = file.read(fd, buf);
      if (n < 0) {
        return mapErrno(file.readErrno(), total);
      }
      if (n === 0) {
        if (expectedSize !== undefined && total < expectedSize) {
          return {
            ok: false,
            code: "IO_ERROR",
            message: sourceAvailabilityMessage(
              "IO_ERROR",
              `short_read expected=${expectedSize} read=${total}`
            ),
          };
        }
        break;
      }
      chunks.push(buf.slice(0, n));
      total += n;
    }
    return { ok: true, bytes: concatChunks(chunks, total) };
  } finally {
    file.close(fd);
  }
}

function mapErrno(errno: number, bytesAlreadyRead: number): SourceReadResult {
  const kind = classifyGuardedReadErrno(errno);
  if (kind === "EDEADLK") {
    if (bytesAlreadyRead > 0) {
      return {
        ok: false,
        code: "CLOUD_PARTIAL",
        message: sourceAvailabilityMessage("CLOUD_PARTIAL", `errno=${errno}`),
        errno,
      };
    }
    return {
      ok: false,
      code: "CLOUD_PLACEHOLDER",
      message: sourceAvailabilityMessage("CLOUD_PLACEHOLDER", `errno=${errno}`),
      errno,
    };
  }
  if (kind === "EACCES" || kind === "EPERM") {
    return {
      ok: false,
      code: "PERMISSION",
      message: sourceAvailabilityMessage("PERMISSION", `errno=${errno}`),
      errno,
    };
  }
  if (kind === "ENOENT") {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: sourceAvailabilityMessage("NOT_FOUND", `errno=${errno}`),
      errno,
    };
  }
  if (kind === "EISDIR") {
    return {
      ok: false,
      code: "NOT_FILE",
      message: sourceAvailabilityMessage("NOT_FILE", `errno=${errno}`),
      errno,
    };
  }
  if (kind === "ELOOP") {
    return {
      ok: false,
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      message: sourceAvailabilityMessage(
        "SOURCE_AVAILABILITY_UNKNOWN",
        `symlink_loop errno=${errno}`
      ),
      errno,
    };
  }
  // Unknown errno / flags / safety: fail closed, never claim safe to read.
  return {
    ok: false,
    code: "SOURCE_AVAILABILITY_UNKNOWN",
    message: sourceAvailabilityMessage(
      "SOURCE_AVAILABILITY_UNKNOWN",
      `errno=${errno}`
    ),
    errno,
  };
}

function mapNodeLikeReadError(error: unknown): SourceReadResult {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (code === "ENOENT") {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: sourceAvailabilityMessage("NOT_FOUND"),
    };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "PERMISSION",
      message: sourceAvailabilityMessage("PERMISSION"),
    };
  }
  if (code === "EISDIR") {
    return {
      ok: false,
      code: "NOT_FILE",
      message: sourceAvailabilityMessage("NOT_FILE"),
    };
  }
  const detail = error instanceof Error ? error.message : "read_failed";
  return {
    ok: false,
    code: "IO_ERROR",
    message: sourceAvailabilityMessage("IO_ERROR", detail),
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Factory: mode → reader. Local uses Darwin guard; unsupported platforms fail closed. */
export function createSourceContentReader(
  mode: SourceAvailabilityMode,
  deps: LocalReaderDeps = {}
): SourceContentReaderPort {
  if (mode === "any") {
    return new AnySourceContentReader();
  }
  return new LocalSourceContentReader(deps);
}

/** Yield one pre-read buffer as an async iterable (record-import open seam). */
export function bytesAsAsyncIterable(
  bytes: Uint8Array,
  signal?: AbortSignal
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal?.aborted) {
        throw new Error("source read aborted");
      }
      if (bytes.byteLength > 0) {
        yield bytes;
      }
    },
  };
}
