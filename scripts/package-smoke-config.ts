/** Isolated packed-config helpers for the package smoke. */

// node:url: pathToFileURL has no Bun-native equivalent.
import { pathToFileURL } from "node:url";

export async function configurePackedEmbeddingModel(
  configPath: string,
  modelPath: string
): Promise<void> {
  const config = Bun.YAML.parse(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >;
  const modelUri = pathToFileURL(modelPath).href;
  config.models = {
    activePreset: "package-smoke-local",
    presets: [
      {
        id: "package-smoke-local",
        name: "Package Smoke Local",
        embed: modelUri,
        rerank: modelUri,
        expand: modelUri,
        gen: modelUri,
      },
    ],
  };
  await Bun.write(configPath, Bun.YAML.stringify(config));
}
