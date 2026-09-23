import { previewCompiledContext } from "../../app/compiled-context";
import {
  compileContextFile,
  checkContextFile,
  refreshContextFile,
} from "../../app/compiled-context-files";
/** Explicit local compiled context operations. */
import { createGnoClient } from "../../sdk/client";
import { CliError } from "../errors";
import { contextCliError } from "./context-build";
import { initStore } from "./shared";

export interface CompiledCommandOptions {
  configPath?: string;
  indexName?: string;
  capsulePath?: string;
  capsuleOutputPath?: string;
  outputPath?: string;
  budgetTokens?: number;
  budgetBytes?: number;
  json?: boolean;
}

export async function contextCompiled(
  operation: "preview" | "compile" | "check" | "refresh",
  options: CompiledCommandOptions
): Promise<{
  output: string;
  status?: "current" | "stale" | "conflict" | "unverifiable";
}> {
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: false,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) throw new CliError("RUNTIME", initialized.error);
  const deps = {
    store: initialized.store,
    config: initialized.config,
    indexName: options.indexName,
  };
  try {
    if (operation === "check") {
      if (!options.outputPath)
        throw new CliError("VALIDATION", "Artifact path required");
      const result = await checkContextFile(
        { outputPath: options.outputPath, capsulePath: options.capsulePath },
        deps
      );
      return {
        output: options.json
          ? JSON.stringify(result)
          : `${result.status}: ${result.reasons.join("; ") || "verified current"}`,
        status: result.status,
      };
    }
    if (operation === "refresh") {
      if (!options.outputPath || !options.capsuleOutputPath)
        throw new CliError(
          "VALIDATION",
          "Artifact and Capsule output paths required"
        );
      const result = await refreshContextFile(
        {
          outputPath: options.outputPath,
          capsuleOutputPath: options.capsuleOutputPath,
        },
        deps,
        async (request) => {
          const client = await createGnoClient({
            configPath: options.configPath,
            indexName: options.indexName,
          });
          try {
            return await client.context(request);
          } finally {
            await client.close();
          }
        }
      );
      return {
        output: options.json
          ? JSON.stringify(result)
          : `${result.status}: ${result.outputPath}`,
      };
    }
    if (!options.capsulePath || !options.budgetTokens)
      throw new CliError("VALIDATION", "Capsule path and budget required");
    if (operation === "compile") {
      if (!options.outputPath)
        throw new CliError("VALIDATION", "Output path required");
      const result = await compileContextFile(
        {
          capsulePath: options.capsulePath,
          outputPath: options.outputPath,
          budgetTokens: options.budgetTokens,
          budgetBytes: options.budgetBytes,
        },
        deps
      );
      return {
        output: options.json
          ? JSON.stringify(result)
          : `${result.status}: ${result.outputPath}`,
      };
    }
    const source = Bun.file(options.capsulePath);
    if (source.size > 4 * 1024 * 1024)
      throw new CliError("VALIDATION", "Capsule exceeds byte limit");
    const capsule: unknown = await source.json();
    const result = await previewCompiledContext(
      {
        capsule,
        budgetTokens: options.budgetTokens,
        budgetBytes: options.budgetBytes,
      },
      deps
    );
    return { output: options.json ? JSON.stringify(result) : result.markdown };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "ZodError")
    ) {
      throw new CliError(
        "VALIDATION",
        "Invalid compiled context input; provide a valid Capsule and budget"
      );
    }
    throw contextCliError(error);
  } finally {
    await initialized.store.close();
  }
}
