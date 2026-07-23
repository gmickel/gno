/** Admission, bounded-reader, and model-lease boundary for resident REST reads. */

import type { ResidentRuntime } from "./resident-runtime";

function unavailableResponse(): Response {
  return Response.json(
    { error: { code: "UNAVAILABLE", message: "Resident runtime unavailable" } },
    { status: 503 }
  );
}

function saturatedResponse(): Response {
  return Response.json(
    {
      error: { code: "RATE_LIMITED", message: "Resident reader queue is full" },
    },
    { status: 429 }
  );
}

export async function handleResidentRead(
  runtime: ResidentRuntime,
  request: Request | undefined,
  operation: (signal: AbortSignal) => Promise<Response> | Response
): Promise<Response> {
  const admitted = runtime.admitRequest(request?.signal);
  if (!admitted) return unavailableResponse();

  let releaseReader: (() => void) | undefined;
  try {
    releaseReader = await runtime.readerGate.acquire(admitted.signal);
    if (admitted.signal.aborted) return unavailableResponse();
    const response = await runtime.withModelLease(() =>
      Promise.resolve(operation(admitted.signal))
    );
    return admitted.signal.aborted ? unavailableResponse() : response;
  } catch (error) {
    if (
      admitted.signal.aborted ||
      (error instanceof Error && error.message === "Resident request aborted")
    ) {
      return unavailableResponse();
    }
    if (
      error instanceof Error &&
      error.message === "Resident reader queue is full"
    ) {
      return saturatedResponse();
    }
    throw error;
  } finally {
    releaseReader?.();
    admitted.finish();
  }
}
