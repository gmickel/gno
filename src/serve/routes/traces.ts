/** Loopback REST handlers for private retrieval trace management. */

import type {
  RetrievalTraceExportRequest,
  RetrievalTraceLabelRequest,
} from "../../core/retrieval-trace-management";
import type { StoreError, StorePort, StoreResult } from "../../store/types";

import { RetrievalTraceManagementService } from "../../core/retrieval-trace-management";

const errorStatus = (error: StoreError): number => {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "CONSTRAINT_VIOLATION") return 409;
  if (error.code === "INVALID_INPUT") return 400;
  return 500;
};

const response = <T>(result: StoreResult<T>): Response => {
  if (result.ok) return Response.json(result.value);
  return Response.json(
    {
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    },
    { status: errorStatus(result.error) }
  );
};

const parseJsonObject = async (
  request: Request
): Promise<Record<string, unknown> | Response> => {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Response.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Request body must be a JSON object",
          },
        },
        { status: 400 }
      );
    }
    return value as Record<string, unknown>;
  } catch {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "Request body must be valid JSON",
        },
      },
      { status: 400 }
    );
  }
};

const parseOptionalInteger = (
  value: string | null
): number | undefined | null => {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const handleTraceList = async (
  store: StorePort,
  request: Request
): Promise<Response> => {
  const url = new URL(request.url);
  const limit = parseOptionalInteger(url.searchParams.get("limit"));
  if (limit === null) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "limit must be a positive integer",
        },
      },
      { status: 400 }
    );
  }
  return response(
    await new RetrievalTraceManagementService(store).list({
      limit,
      cursor: url.searchParams.get("cursor") ?? undefined,
    })
  );
};

export const handleTraceShow = async (
  store: StorePort,
  traceId: string,
  request: Request
): Promise<Response> => {
  const detailLimit = parseOptionalInteger(
    new URL(request.url).searchParams.get("detailLimit")
  );
  if (detailLimit === null) {
    return Response.json(
      {
        error: {
          code: "INVALID_INPUT",
          message: "detailLimit must be a positive integer",
        },
      },
      { status: 400 }
    );
  }
  return response(
    await new RetrievalTraceManagementService(store).show(traceId, {
      detailLimit,
    })
  );
};

export const handleTraceLabel = async (
  store: StorePort,
  traceId: string,
  request: Request
): Promise<Response> => {
  const body = await parseJsonObject(request);
  if (body instanceof Response) return body;
  return response(
    await new RetrievalTraceManagementService(store).label({
      ...body,
      traceId,
    } as unknown as RetrievalTraceLabelRequest)
  );
};

export const handleTraceExport = async (
  store: StorePort,
  request: Request
): Promise<Response> => {
  const body = await parseJsonObject(request);
  if (body instanceof Response) return body;
  return response(
    await new RetrievalTraceManagementService(store).export(
      body as unknown as RetrievalTraceExportRequest
    )
  );
};

export const handleTraceDelete = async (
  store: StorePort,
  traceId: string
): Promise<Response> =>
  response(await new RetrievalTraceManagementService(store).delete(traceId));

export const handleTracePurge = async (store: StorePort): Promise<Response> =>
  response(await new RetrievalTraceManagementService(store).purge());
