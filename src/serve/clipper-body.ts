/** Bounded UTF-8 JSON reader for the browser-clipper boundary. */

import { clipperSecurityErrorResponse } from "./clipper-security-errors";

export type ClipperBodyReadResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

export async function readClipperBoundedJson(
  request: Request,
  maxBytes: number
): Promise<ClipperBodyReadResult> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    return {
      ok: false,
      response: clipperSecurityErrorResponse("CLIPPER_BODY_TOO_LARGE"),
    };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return {
      ok: false,
      response: clipperSecurityErrorResponse("CLIPPER_INVALID_JSON"),
    };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return {
        ok: false,
        response: clipperSecurityErrorResponse("CLIPPER_BODY_TOO_LARGE"),
      };
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: clipperSecurityErrorResponse("CLIPPER_INVALID_JSON"),
    };
  }
}
