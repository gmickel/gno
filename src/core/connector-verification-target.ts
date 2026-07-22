/** Connector target normalization and privacy-bounded receipt identity. */

// node:path has no Bun equivalent for portable resolved path identity.
import { resolve } from "node:path";

import type { ConnectorWorkspaceEnvironment } from "./connector-environment";

import { normalizeConnectorWorkspaceEnvironment } from "./connector-environment";

const CONNECTOR_VERIFIER_IMPLEMENTATION_ID = "mcp-stdio-readonly-v2";

interface ConnectorTargetBase {
  id: string;
  target: string;
  scope: "user" | "project";
  configPath: string;
  configError?: boolean;
}

export interface McpConnectorVerificationTarget extends ConnectorTargetBase {
  kind: "mcp";
  configured: boolean;
  serverEntry?: {
    command: string;
    args: string[];
    env?: ConnectorWorkspaceEnvironment;
  };
  /** Privacy-bounded identity of the complete client entry. */
  configIdentity?: string;
}

export interface SkillConnectorVerificationTarget extends ConnectorTargetBase {
  kind: "skill";
  installed: boolean;
  /** Reserved for a future client-owned, read-only runtime verification hook. */
  runtimeHook?: never;
}

export type ConnectorVerificationTarget =
  | McpConnectorVerificationTarget
  | SkillConnectorVerificationTarget;

export interface ConnectorTargetIdentity {
  connectorTarget: string;
  normalized: Record<string, unknown>;
}

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

export function targetIdentity(
  target: ConnectorVerificationTarget
): ConnectorTargetIdentity {
  const configPathIdentity = sha256(resolve(target.configPath));
  const normalized = {
    kind: target.kind,
    id: target.id,
    target: target.target,
    scope: target.scope,
    configPathIdentity,
    configError: target.configError === true,
    ...(target.kind === "mcp"
      ? {
          configured: target.configured,
          command: target.serverEntry?.command ?? null,
          args: target.serverEntry?.args ?? [],
          env: target.serverEntry?.env ?? {},
          configIdentity: target.configIdentity ?? null,
        }
      : { installed: target.installed }),
  };
  return {
    connectorTarget: `${target.kind}:${target.target}:${target.scope}:${configPathIdentity}`,
    normalized,
  };
}

export function normalizeConnectorTarget(
  target: ConnectorVerificationTarget
): ConnectorVerificationTarget {
  if (target.kind !== "mcp") {
    return target;
  }
  if (!target.configured) {
    return { ...target, serverEntry: undefined };
  }
  const entry: unknown = target.serverEntry;
  if (!entry || typeof entry !== "object") {
    return { ...target, configured: false, configError: true };
  }
  const record = entry as { command?: unknown; args?: unknown; env?: unknown };
  const entryKeys = Object.keys(record);
  const env = normalizeConnectorWorkspaceEnvironment(record.env);
  if (
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string") ||
    entryKeys.some(
      (key) => key !== "command" && key !== "args" && key !== "env"
    ) ||
    env === null
  ) {
    return {
      ...target,
      configured: false,
      serverEntry: undefined,
      configIdentity:
        target.configIdentity ?? sha256(JSON.stringify(entry) ?? "undefined"),
      configError: true,
    };
  }
  return {
    ...target,
    serverEntry: {
      command: record.command,
      args: record.args,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

export function connectorFingerprint(
  lexicalFingerprint: string,
  normalizedTarget: Record<string, unknown>
): string {
  return sha256(
    JSON.stringify({
      lexicalFingerprint,
      connectorVerifier: CONNECTOR_VERIFIER_IMPLEMENTATION_ID,
      target: normalizedTarget,
    })
  );
}

/** Pure lookup key for reading one target's fingerprint-current receipt. */
export function getConnectorActivationReceiptLookup(
  lexicalFingerprint: string,
  target: ConnectorVerificationTarget
): { connectorTarget: string; fingerprint: string } {
  const normalizedTarget = normalizeConnectorTarget(target);
  const identity = targetIdentity(normalizedTarget);
  return {
    connectorTarget: identity.connectorTarget,
    fingerprint: connectorFingerprint(lexicalFingerprint, identity.normalized),
  };
}
