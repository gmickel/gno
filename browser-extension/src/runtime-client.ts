import type { CaptureDestinationDetails } from "./contracts";

interface RuntimeReply<T> {
  ok: boolean;
  result?: T;
  error?: {
    code: string;
    message: string;
    details?: CaptureDestinationDetails;
  };
}

export class ClipperClientError extends Error {
  readonly code: string;
  /** The structured refusal reason the service worker forwarded, if any. */
  readonly details?: CaptureDestinationDetails;

  constructor(
    code: string,
    message: string,
    details?: CaptureDestinationDetails
  ) {
    super(message);
    this.name = "ClipperClientError";
    this.code = code;
    if (details) this.details = details;
  }
}

export const sendClipperMessage = async <T>(message: unknown): Promise<T> => {
  const reply = (await chrome.runtime.sendMessage(message)) as RuntimeReply<T>;
  if (!reply.ok || reply.result === undefined) {
    throw new ClipperClientError(
      reply.error?.code ?? "CLIPPER_CLIENT",
      reply.error?.message ?? "Browser clipper request failed.",
      reply.error?.details
    );
  }
  return reply.result;
};
