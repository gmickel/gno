export type Utf8LineResult =
  | {
      ok: true;
      lineNumber: number;
      text: string;
      terminated: boolean;
    }
  | {
      ok: false;
      lineNumber: number;
      reason: "invalid_utf8" | "line_too_large";
      terminated: boolean;
    };

const BYTE_LF = 0x0a;
const BYTE_CR = 0x0d;
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

const createUtf8Decoder = (): TextDecoder =>
  new TextDecoder("utf-8", { fatal: true });

const concatenate = (
  parts: readonly Uint8Array[],
  byteLength: number
): Uint8Array => {
  if (parts.length === 1) return parts[0] ?? new Uint8Array();
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const stripLineEnvelope = (
  bytes: Uint8Array,
  lineNumber: number
): Uint8Array => {
  let start = 0;
  let end = bytes.byteLength;
  if (
    lineNumber === 1 &&
    end >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  ) {
    start = 3;
  }
  if (end > start && bytes[end - 1] === BYTE_CR) end -= 1;
  return start === 0 && end === bytes.byteLength
    ? bytes
    : bytes.subarray(start, end);
};

const decodeSingleBytes = (
  rawBytes: Uint8Array,
  lineNumber: number,
  terminated: boolean,
  decoderState: { decoder: TextDecoder }
): Utf8LineResult => {
  const bytes = stripLineEnvelope(rawBytes, lineNumber);
  try {
    return {
      ok: true,
      lineNumber,
      text: decoderState.decoder.decode(bytes),
      terminated,
    };
  } catch {
    // Recreate the fatal decoder after an error so no runtime-specific error
    // state can bleed into subsequent valid lines.
    decoderState.decoder = createUtf8Decoder();
    return {
      ok: false,
      lineNumber,
      reason: "invalid_utf8",
      terminated,
    };
  }
};

const decodeLine = (
  parts: readonly Uint8Array[],
  byteLength: number,
  lineNumber: number,
  terminated: boolean,
  decoderState: { decoder: TextDecoder }
): Utf8LineResult =>
  decodeSingleBytes(
    concatenate(parts, byteLength),
    lineNumber,
    terminated,
    decoderState
  );

/**
 * Split an async byte source without retaining an unbounded physical line.
 * Invalid UTF-8 and oversized lines are isolated so later siblings can proceed.
 */
export async function* readBoundedUtf8Lines(
  source: AsyncIterable<Uint8Array>,
  maxLineBytes: number
): AsyncGenerator<Utf8LineResult> {
  const safeMaxLineBytes = Math.max(1, Math.floor(maxLineBytes));
  const decoderState = { decoder: createUtf8Decoder() };
  let parts: Uint8Array[] = [];
  let lineBytes = 0;
  let lineNumber = 1;
  let oversized = false;

  const reset = (): void => {
    parts = [];
    lineBytes = 0;
    oversized = false;
    lineNumber += 1;
  };

  for await (const chunk of source) {
    let segmentStart = 0;
    while (segmentStart < chunk.byteLength) {
      const nl = chunk.indexOf(BYTE_LF, segmentStart);
      if (nl === -1) break;
      const segmentLen = nl - segmentStart;
      if (!oversized && lineBytes + segmentLen <= safeMaxLineBytes) {
        if (parts.length === 0) {
          yield decodeSingleBytes(
            chunk.subarray(segmentStart, nl),
            lineNumber,
            true,
            decoderState
          );
        } else {
          if (segmentLen > 0) parts.push(chunk.subarray(segmentStart, nl));
          yield decodeLine(
            parts,
            lineBytes + segmentLen,
            lineNumber,
            true,
            decoderState
          );
        }
      } else {
        yield {
          ok: false,
          lineNumber,
          reason: "line_too_large",
          terminated: true,
        };
      }
      reset();
      segmentStart = nl + 1;
    }

    const remainderLen = chunk.byteLength - segmentStart;
    if (remainderLen > 0) {
      if (!oversized && lineBytes + remainderLen <= safeMaxLineBytes) {
        parts.push(chunk.subarray(segmentStart).slice());
        lineBytes += remainderLen;
      } else {
        oversized = true;
        parts = [];
        lineBytes = 0;
      }
    }
  }

  if (oversized) {
    yield {
      ok: false,
      lineNumber,
      reason: "line_too_large",
      terminated: false,
    };
  } else if (lineBytes > 0) {
    yield decodeLine(parts, lineBytes, lineNumber, false, decoderState);
  }
}
