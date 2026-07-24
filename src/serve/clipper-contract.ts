/** Closed request parsing and stable responses for browser-clipper routes. */

import { z } from "zod";

const PAIR_ID_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/u;

export const clipperApprovalSchema = z
  .object({
    pairId: z.string().regex(PAIR_ID_PATTERN),
    pairingCode: z.string().regex(/^\d{8}$/u),
  })
  .strict();

export const clipperCaptureWriteSchema = z
  .object({
    payload: z.unknown(),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const isClipperPairId = (value: string): boolean =>
  PAIR_ID_PATTERN.test(value);

export const isClipperIdempotencyKey = (value: string): boolean =>
  IDEMPOTENCY_KEY_PATTERN.test(value);

export const clipperLoopbackAuthority = (
  host: string,
  port: number
): string => {
  const authorityHost = host === "::1" || host === "[::1]" ? "[::1]" : host;
  return `${authorityHost}:${port}`;
};

export const clipperBearerToken = (request: Request): string | null =>
  request.headers
    .get("authorization")
    ?.match(/^Bearer (?<token>[a-f0-9]{64})$/u)?.groups?.token ?? null;

export const clipperSha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const clipperResponse = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export const clipperErrorResponse = (
  code: string,
  message: string,
  status: number
): Response => clipperResponse({ error: { code, message } }, status);
