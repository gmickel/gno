import type { ResidentRuntime } from "./resident-runtime";
/** Admission and bounded-reader boundary for resident REST reads. */

import { withInferenceScope } from "../llm/inference-scope";

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

function policyChangedResponse(): Response {
  return Response.json(
    {
      error: {
        code: "EGRESS_POLICY_CHANGED",
        message: "Collection policy changed; retry",
      },
    },
    { status: 409 }
  );
}

function wrapResidentStream(
  response: Response,
  isCurrent: () => boolean,
  finish: () => void
): Response {
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finishOnce = (): void => {
    if (finished) return;
    finished = true;
    finish();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!isCurrent()) {
          await reader.cancel("EGRESS_POLICY_CHANGED");
          controller.close();
          finishOnce();
          return;
        }
        const result = await reader.read();
        if (!isCurrent()) {
          await reader.cancel("EGRESS_POLICY_CHANGED");
          controller.close();
          finishOnce();
          return;
        }
        if (result.done) {
          controller.close();
          finishOnce();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        finishOnce();
      }
    },
    async cancel(reason) {
      finishOnce();
      await reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

export async function handleResidentRead(
  runtime: ResidentRuntime,
  request: Request | undefined,
  operation: (signal: AbortSignal) => Promise<Response> | Response
): Promise<Response> {
  const admitted = runtime.admitRequest(request?.signal);
  if (!admitted) return unavailableResponse();

  let releaseReader: (() => void) | undefined;
  let deferredFinish = false;
  const isAuthorizationEpochCurrent = (): boolean =>
    admitted.isAuthorizationEpochCurrent?.() ?? true;
  const finish = (): void => {
    releaseReader?.();
    admitted.finish();
  };
  try {
    releaseReader = await runtime.readerGate.acquire(admitted.signal);
    if (admitted.signal.aborted) return unavailableResponse();
    const response = await withInferenceScope(
      { signal: admitted.signal },
      async () => operation(admitted.signal)
    );
    if (admitted.signal.aborted) return unavailableResponse();
    if (!isAuthorizationEpochCurrent()) {
      return policyChangedResponse();
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      deferredFinish = true;
      return wrapResidentStream(
        response,
        () => !admitted.signal.aborted && isAuthorizationEpochCurrent(),
        finish
      );
    }
    return response;
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
    if (!deferredFinish) finish();
  }
}
