/** Dedicated loopback browser-clipper HTTP gateway. */

import type { HttpMcpPeerServer } from "../../mcp/http-security";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { ContextHolder } from "./api";

import { prepareBrowserClip } from "../../core/browser-clip";
import {
  planResidentCapture,
  type ResidentCapturePlanResult,
} from "../capture-service";
import { executeClipperCapture } from "../clipper-capture";
import {
  clipperApprovalSchema,
  clipperBearerToken,
  clipperErrorResponse,
  clipperLoopbackAuthority,
  clipperResponse,
  clipperSha256,
  isClipperPairId,
} from "../clipper-contract";
import {
  ClipperPairingService,
  type ClipperPairPollResult,
} from "../clipper-pairing";
import {
  ClipperSecurityBoundary,
  type ClipperAdmission,
  withClipperCors,
} from "../clipper-security";

type ClipperRoute = (
  request: Request,
  server: HttpMcpPeerServer
) => Promise<Response> | Response;

export interface ClipperRouteGateway {
  readonly routes: Record<
    string,
    Partial<Record<"GET" | "POST" | "OPTIONS", ClipperRoute>>
  >;
}

interface AuthenticatedAdmission {
  admission: ClipperAdmission;
  grant: Extract<
    ReturnType<ClipperPairingService["authorize"]>,
    { status: "authorized" }
  >["grant"];
}

const releaseWithCors = (
  admission: ClipperAdmission,
  result: Response
): Response => {
  admission.release();
  return withClipperCors(result, admission.origin);
};

const planProjection = (
  planned: Extract<ResidentCapturePlanResult, { ok: true }>
): {
  collection: string;
  relPath: string;
  outcome: string;
  provenanceConflict: boolean;
} => ({
  collection: planned.plan.collection,
  relPath: planned.plan.relPath,
  outcome: planned.plan.collisionPolicyResult,
  provenanceConflict: planned.plan.provenanceConflict,
});

const pollStatusCode = (result: ClipperPairPollResult): number => {
  if (result.status === "not_found") return 404;
  if (
    result.status === "expired" ||
    result.status === "consumed" ||
    result.status === "origin_mismatch"
  ) {
    return 410;
  }
  return 200;
};

export function createClipperRouteGateway(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  options: { host: string; port: number }
): ClipperRouteGateway {
  const authority = clipperLoopbackAuthority(options.host, options.port);
  const listenerOrigin = `http://${authority}`;
  const security = new ClipperSecurityBoundary({
    allowedHosts: [authority],
    sameOrigins: [listenerOrigin],
  });
  const pairing = new ClipperPairingService(store.getRawDb());
  const db = store.getRawDb();

  const admitExtension = async (
    request: Request,
    server: HttpMcpPeerServer,
    readJson: boolean
  ) =>
    security.admit(request, server, {
      origin: { kind: "extension" },
      readJson,
    });

  const authenticate = async (
    request: Request,
    server: HttpMcpPeerServer,
    readJson: boolean
  ): Promise<
    | { ok: true; value: AuthenticatedAdmission }
    | { ok: false; response: Response }
  > => {
    const admitted = await admitExtension(request, server, readJson);
    if (!admitted.ok) return admitted;
    const token = clipperBearerToken(request);
    if (!token) {
      return {
        ok: false,
        response: releaseWithCors(
          admitted.value,
          clipperErrorResponse("CLIPPER_UNAUTHORIZED", "Unauthorized", 401)
        ),
      };
    }
    const authorized = pairing.authorize(token, admitted.value.origin);
    if (authorized.status !== "authorized") {
      return {
        ok: false,
        response: releaseWithCors(
          admitted.value,
          clipperErrorResponse("CLIPPER_UNAUTHORIZED", "Unauthorized", 401)
        ),
      };
    }
    return {
      ok: true,
      value: { admission: admitted.value, grant: authorized.grant },
    };
  };

  const startPair: ClipperRoute = async (request, server) => {
    const admitted = await admitExtension(request, server, false);
    if (!admitted.ok) return admitted.response;
    try {
      const started = pairing.start(admitted.value.origin);
      return withClipperCors(
        clipperResponse({
          schemaVersion: "1.0",
          ...started,
          origin: admitted.value.origin,
          approvalPath: "/api/clipper/pair/approve",
        }),
        admitted.value.origin
      );
    } catch (error) {
      return withClipperCors(
        clipperErrorResponse(
          "CLIPPER_PAIRING_UNAVAILABLE",
          error instanceof Error ? error.message : "Pairing unavailable",
          429
        ),
        admitted.value.origin
      );
    } finally {
      admitted.value.release();
    }
  };

  const csrf: ClipperRoute = async (request, server) => {
    const admitted = await security.admit(request, server, {
      origin: { kind: "same-origin" },
    });
    if (!admitted.ok) return admitted.response;
    try {
      return clipperResponse({
        schemaVersion: "1.0",
        csrfToken: pairing.csrfToken,
      });
    } finally {
      admitted.value.release();
    }
  };

  const approvePair: ClipperRoute = async (request, server) => {
    const admitted = await security.admit(request, server, {
      origin: { kind: "same-origin" },
      readJson: true,
    });
    if (!admitted.ok) return admitted.response;
    try {
      if (request.headers.get("x-gno-csrf") !== pairing.csrfToken) {
        return clipperErrorResponse("CLIPPER_CSRF", "Invalid CSRF token", 403);
      }
      const parsed = clipperApprovalSchema.safeParse(admitted.value.body);
      if (!parsed.success) {
        return clipperErrorResponse(
          "CLIPPER_INVALID_REQUEST",
          "Invalid pairing approval",
          400
        );
      }
      const approved = pairing.approve(
        parsed.data.pairId,
        parsed.data.pairingCode
      );
      if (approved.status !== "approved") {
        const status = approved.status === "invalid_code" ? 403 : 410;
        return clipperErrorResponse(
          `CLIPPER_PAIR_${approved.status.toUpperCase()}`,
          "Pairing could not be approved",
          status
        );
      }
      return clipperResponse({
        schemaVersion: "1.0",
        status: approved.status,
        origin: approved.origin,
        expiresAt: approved.expiresAt,
      });
    } finally {
      admitted.value.release();
    }
  };

  const pollPair: ClipperRoute = async (request, server) => {
    const admitted = await admitExtension(request, server, false);
    if (!admitted.ok) return admitted.response;
    try {
      const pairId = new URL(request.url).pathname.split("/").at(-1) ?? "";
      if (!isClipperPairId(pairId)) {
        return withClipperCors(
          clipperErrorResponse(
            "CLIPPER_PAIR_NOT_FOUND",
            "Pairing not found",
            404
          ),
          admitted.value.origin
        );
      }
      const result = pairing.poll(pairId, admitted.value.origin);
      return withClipperCors(
        clipperResponse(
          { schemaVersion: "1.0", ...result },
          pollStatusCode(result)
        ),
        admitted.value.origin
      );
    } finally {
      admitted.value.release();
    }
  };

  const revoke: ClipperRoute = async (request, server) => {
    const authenticated = await authenticate(request, server, false);
    if (!authenticated.ok) return authenticated.response;
    const { admission, grant } = authenticated.value;
    try {
      const revoked = pairing.revoke(grant);
      return withClipperCors(
        clipperResponse({
          schemaVersion: "1.0",
          grantId: grant.id,
          ...revoked,
        }),
        admission.origin
      );
    } finally {
      admission.release();
    }
  };

  const preview: ClipperRoute = async (request, server) => {
    const authenticated = await authenticate(request, server, true);
    if (!authenticated.ok) return authenticated.response;
    const { admission, grant } = authenticated.value;
    try {
      const prepared = prepareBrowserClip(admission.body);
      const planned = await planResidentCapture(
        ctxHolder,
        store,
        prepared.captureInput
      );
      if (!planned.ok) {
        return withClipperCors(
          clipperErrorResponse(planned.code, planned.message, planned.status),
          admission.origin
        );
      }
      const payloadDigest = clipperSha256(JSON.stringify(prepared.payload));
      pairing.issuePreview(grant.id, prepared.preview.digest, payloadDigest);
      return withClipperCors(
        clipperResponse({
          schemaVersion: "1.0",
          preview: prepared.preview,
          provenance: prepared.provenance,
          plan: planProjection(planned),
        }),
        admission.origin
      );
    } catch (error) {
      return withClipperCors(
        clipperErrorResponse(
          "CLIPPER_INVALID_REQUEST",
          error instanceof Error ? error.message : "Invalid browser clip",
          400
        ),
        admission.origin
      );
    } finally {
      admission.release();
    }
  };

  const capture: ClipperRoute = async (request, server) => {
    const authenticated = await authenticate(request, server, true);
    if (!authenticated.ok) return authenticated.response;
    const { admission, grant } = authenticated.value;
    try {
      return withClipperCors(
        await executeClipperCapture({
          request,
          body: admission.body,
          grantId: grant.id,
          db,
          context: ctxHolder,
          store,
          pairing,
        }),
        admission.origin
      );
    } catch (error) {
      return withClipperCors(
        clipperErrorResponse(
          "CLIPPER_CAPTURE_FAILED",
          error instanceof Error ? error.message : "Browser capture failed",
          500
        ),
        admission.origin
      );
    } finally {
      admission.release();
    }
  };

  const preflight =
    (methods: readonly string[], headers?: readonly string[]): ClipperRoute =>
    (request, server) =>
      security.handlePreflight(request, server, {
        origin: { kind: "extension" },
        methods,
        headers,
      });

  return {
    routes: {
      "/api/clipper/pair/start": {
        POST: startPair,
        OPTIONS: preflight(["POST"]),
      },
      "/api/clipper/pair/csrf": {
        GET: csrf,
      },
      "/api/clipper/pair/approve": {
        POST: approvePair,
      },
      "/api/clipper/pair/:pairId": {
        GET: pollPair,
        OPTIONS: preflight(["GET"]),
      },
      "/api/clipper/revoke": {
        POST: revoke,
        OPTIONS: preflight(["POST"], ["authorization"]),
      },
      "/api/capture/clip/preview": {
        POST: preview,
        OPTIONS: preflight(["POST"]),
      },
      "/api/capture/clip": {
        POST: capture,
        OPTIONS: preflight(["POST"]),
      },
    },
  };
}

export const clipperRoutesForBind = (
  loopback: boolean,
  gateway: ClipperRouteGateway
): ClipperRouteGateway["routes"] => (loopback ? gateway.routes : {});
