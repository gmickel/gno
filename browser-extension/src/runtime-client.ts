interface RuntimeReply<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class ClipperClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClipperClientError";
    this.code = code;
  }
}

export const sendClipperMessage = async <T>(message: unknown): Promise<T> => {
  const reply = (await chrome.runtime.sendMessage(message)) as RuntimeReply<T>;
  if (!reply.ok || reply.result === undefined) {
    throw new ClipperClientError(
      reply.error?.code ?? "CLIPPER_CLIENT",
      reply.error?.message ?? "Browser clipper request failed."
    );
  }
  return reply.result;
};
