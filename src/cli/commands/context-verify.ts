/** Context Capsule verification command over the shared application runtime. */

import { formatContextCapsuleVerificationMarkdown } from "../../app/context-format";
import {
  canonicalVerifiedContextCapsuleJson,
  verifyContextCapsuleRuntime,
} from "../../app/context-runtime";
import { canonicalizeIndexName } from "../../app/index-name";
import { parseCanonicalContextCapsuleForVerification } from "../../core/context-verifier";
import { CliError } from "../errors";
import { contextCliError } from "./context-build";
import { initStore } from "./shared";

export interface ContextVerifyCommandOptions {
  configPath?: string;
  indexName?: string;
  format: "json" | "md";
}

const readCapsule = async (source: string): Promise<unknown> => {
  let raw: string;
  try {
    raw =
      source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
  } catch (error) {
    throw new CliError(
      "RUNTIME",
      `Failed to read Context Capsule: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CliError("VALIDATION", "Context Capsule must be valid JSON", {
      details: {
        contextCode: "invalid_input",
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

export const contextVerify = async (
  source: string,
  options: ContextVerifyCommandOptions
): Promise<string> => {
  const input = await readCapsule(source);
  let capsule: ReturnType<typeof parseCanonicalContextCapsuleForVerification>;
  try {
    capsule = parseCanonicalContextCapsuleForVerification(input);
  } catch (error) {
    throw contextCliError(error);
  }
  if (
    options.indexName !== undefined &&
    canonicalizeIndexName(options.indexName) !== capsule.scope.indexName
  ) {
    throw new CliError(
      "VALIDATION",
      `Context Capsule index ${capsule.scope.indexName} does not match --index ${options.indexName}`,
      { details: { contextCode: "invalid_filter" } }
    );
  }
  const initResult = await initStore({
    configPath: options.configPath,
    indexName: capsule.scope.indexName,
    syncConfig: true,
  });
  if (!initResult.ok) {
    throw new CliError("RUNTIME", initResult.error);
  }
  const { config, store } = initResult;
  try {
    const receipt = await verifyContextCapsuleRuntime(capsule, {
      store,
      config,
      indexName: capsule.scope.indexName,
    });
    return options.format === "md"
      ? formatContextCapsuleVerificationMarkdown(receipt)
      : canonicalVerifiedContextCapsuleJson(receipt);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw contextCliError(error);
  } finally {
    await store.close();
  }
};
