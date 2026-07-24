import type { LocalStorageArea } from "./storage";
import type {
  BrowserClipPayload,
  BrowserClipPreview,
  CaptureReceipt,
  ExtractionResult,
  PairStart,
  PendingCapture,
} from "./types";

import { ClipperGateway, ClipperGatewayError } from "./gateway";
import {
  clearGrant,
  isGrantExpired,
  readClipperState,
  writeClipperState,
} from "./storage";

const PAIR_KEY = "gnoClipperTransientPair";

interface TransientPair extends PairStart {
  gatewayOrigin: string;
}

interface ControllerDependencies {
  local: LocalStorageArea;
  session: LocalStorageArea;
  extensionOrigin: string;
  fetcher?: typeof fetch;
  openApproval(url: string): Promise<void>;
  extract(): Promise<ExtractionResult>;
  sleep(ms: number): Promise<void>;
  randomKey(): string;
}

const isTransientPair = (value: unknown): value is TransientPair => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pair = value as Record<string, unknown>;
  return (
    Object.keys(pair).sort().join(",") ===
      "approvalPath,expiresAt,gatewayOrigin,origin,pairId,pairingCode" &&
    typeof pair.pairId === "string" &&
    /^[a-f0-9]{64}$/u.test(pair.pairId) &&
    typeof pair.pairingCode === "string" &&
    /^\d{8}$/u.test(pair.pairingCode) &&
    typeof pair.expiresAt === "string" &&
    typeof pair.origin === "string" &&
    pair.approvalPath === "/api/clipper/pair/approve" &&
    typeof pair.gatewayOrigin === "string"
  );
};

const samePendingPayload = (
  left: PendingCapture,
  payload: BrowserClipPayload
): boolean => JSON.stringify(left.payload) === JSON.stringify(payload);

export class ClipperController {
  private readonly dependencies: ControllerDependencies;
  private capturePromise: Promise<{
    receipt: CaptureReceipt;
    replayed: boolean;
  }> | null = null;

  constructor(dependencies: ControllerDependencies) {
    this.dependencies = dependencies;
  }

  private gateway(origin: string): ClipperGateway {
    return new ClipperGateway(origin, this.dependencies.fetcher);
  }

  private async transientPair(): Promise<TransientPair | null> {
    const value = (await this.dependencies.session.get(PAIR_KEY))[PAIR_KEY];
    return isTransientPair(value) ? value : null;
  }

  private async clearPair(): Promise<void> {
    await this.dependencies.session.set({ [PAIR_KEY]: null });
  }

  async state(): Promise<{
    connected: boolean;
    expiresAt: string | null;
    pending: Omit<PendingCapture, "idempotencyKey"> | null;
    pairing: TransientPair | null;
  }> {
    const stored = await readClipperState(this.dependencies.local);
    if (stored.grant && isGrantExpired(stored.grant)) {
      await clearGrant(this.dependencies.local);
      return {
        connected: false,
        expiresAt: null,
        pending: null,
        pairing: await this.transientPair(),
      };
    }
    return {
      connected: stored.grant !== null,
      expiresAt: stored.grant?.expiresAt ?? null,
      pending: stored.pending
        ? {
            payload: stored.pending.payload,
            previewDigest: stored.pending.previewDigest,
          }
        : null,
      pairing: await this.transientPair(),
    };
  }

  async startPair(gatewayOrigin: string): Promise<TransientPair> {
    const started = await this.gateway(gatewayOrigin).startPair();
    return this.acceptStartedPair(gatewayOrigin, started);
  }

  async acceptStartedPair(
    gatewayOrigin: string,
    started: PairStart
  ): Promise<TransientPair> {
    const transient = { ...started, gatewayOrigin };
    try {
      this.gateway(gatewayOrigin);
      if (
        !isTransientPair(transient) ||
        started.origin !== this.dependencies.extensionOrigin
      ) {
        throw new Error("invalid pairing state");
      }
    } catch {
      await this.clearPair();
      throw new Error("GNO returned invalid browser pairing state");
    }
    await this.dependencies.session.set({ [PAIR_KEY]: transient });
    await this.dependencies.openApproval(
      `${gatewayOrigin}/clipper/pair#pairId=${started.pairId}`
    );
    return transient;
  }

  async pollPair(): Promise<{
    status: string;
    grantExpiresAt?: string;
  }> {
    const transient = await this.transientPair();
    if (!transient) return { status: "not_started" };
    if (Date.parse(transient.expiresAt) <= Date.now()) {
      await this.clearPair();
      return { status: "expired" };
    }
    const status = await this.gateway(transient.gatewayOrigin).pollPair(
      transient.pairId
    );
    if (status.status === "pending") return { status: "pending" };
    await this.clearPair();
    if (status.status !== "approved") return { status: status.status };
    const stored = await readClipperState(this.dependencies.local);
    await writeClipperState(
      {
        gatewayOrigin: transient.gatewayOrigin,
        grant: {
          grantId: status.grantId,
          grantToken: status.grantToken,
          expiresAt: status.expiresAt,
        },
        pending: stored.pending,
      },
      this.dependencies.local
    );
    return { status: "approved", grantExpiresAt: status.expiresAt };
  }

  extract(): Promise<ExtractionResult> {
    return this.dependencies.extract();
  }

  async preview(payload: BrowserClipPayload): Promise<BrowserClipPreview> {
    const state = await readClipperState(this.dependencies.local);
    if (!state.gatewayOrigin || !state.grant) {
      throw new Error("Pair the browser clipper before previewing.");
    }
    if (isGrantExpired(state.grant)) {
      await clearGrant(this.dependencies.local);
      throw new Error("The browser grant expired. Pair again.");
    }
    const grant = state.grant;
    try {
      return await this.gateway(state.gatewayOrigin).preview(payload, grant);
    } catch (error) {
      if (error instanceof ClipperGatewayError && error.clearGrant) {
        await clearGrant(this.dependencies.local);
      }
      throw error;
    }
  }

  async capture(
    payload: BrowserClipPayload,
    previewDigest: string
  ): Promise<{ receipt: CaptureReceipt; replayed: boolean }> {
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.captureOnce(payload, previewDigest).finally(
      () => {
        this.capturePromise = null;
      }
    );
    return this.capturePromise;
  }

  async resumePending(): Promise<{
    receipt: CaptureReceipt;
    replayed: boolean;
  }> {
    const state = await readClipperState(this.dependencies.local);
    if (!state.pending) {
      throw new Error("No saved browser capture is awaiting recovery.");
    }
    return this.capture(state.pending.payload, state.pending.previewDigest);
  }

  async discardPending(): Promise<void> {
    const state = await readClipperState(this.dependencies.local);
    await writeClipperState(
      { ...state, pending: null },
      this.dependencies.local
    );
  }

  private async captureOnce(
    payload: BrowserClipPayload,
    previewDigest: string
  ): Promise<{ receipt: CaptureReceipt; replayed: boolean }> {
    let state = await readClipperState(this.dependencies.local);
    if (!state.gatewayOrigin || !state.grant) {
      throw new Error("Pair the browser clipper before capturing.");
    }
    if (isGrantExpired(state.grant)) {
      await clearGrant(this.dependencies.local);
      throw new Error("The browser grant expired. Pair again.");
    }
    const grant = state.grant;
    if (state.pending && !samePendingPayload(state.pending, payload)) {
      throw new Error(
        "A different capture is awaiting recovery. Retry or resolve it first."
      );
    }
    let pending =
      state.pending ??
      ({
        payload,
        previewDigest,
        idempotencyKey: this.dependencies.randomKey(),
      } satisfies PendingCapture);
    await writeClipperState({ ...state, pending }, this.dependencies.local);
    const gateway = this.gateway(state.gatewayOrigin);

    for (const delay of [0, 250, 500, 1000]) {
      if (delay > 0) await this.dependencies.sleep(delay);
      try {
        const result = await gateway.capture(pending, grant);
        state = await readClipperState(this.dependencies.local);
        await writeClipperState(
          { ...state, pending: null },
          this.dependencies.local
        );
        return result;
      } catch (error) {
        if (!(error instanceof ClipperGatewayError)) throw error;
        if (error.clearGrant) {
          await clearGrant(this.dependencies.local);
          throw error;
        }
        if (error.refreshPreview) {
          const refreshed = await gateway.preview(pending.payload, grant);
          pending = { ...pending, previewDigest: refreshed.preview.digest };
          await writeClipperState(
            { ...state, pending },
            this.dependencies.local
          );
          continue;
        }
        if (error.retryable) {
          if (delay < 1000) continue;
          throw error;
        }
        state = await readClipperState(this.dependencies.local);
        await writeClipperState(
          { ...state, pending: null },
          this.dependencies.local
        );
        throw error;
      }
    }
    throw new Error("Browser capture retry limit reached");
  }

  async revoke(): Promise<void> {
    const state = await readClipperState(this.dependencies.local);
    if (!state.gatewayOrigin || !state.grant) {
      await clearGrant(this.dependencies.local);
      return;
    }
    try {
      await this.gateway(state.gatewayOrigin).revoke(state.grant);
      await clearGrant(this.dependencies.local);
    } catch (error) {
      if (error instanceof ClipperGatewayError && error.clearGrant) {
        await clearGrant(this.dependencies.local);
        return;
      }
      throw error;
    }
  }
}

export { PAIR_KEY as CLIPPER_PAIR_SESSION_KEY };
