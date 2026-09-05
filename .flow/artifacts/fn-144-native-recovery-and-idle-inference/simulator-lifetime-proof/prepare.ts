import { resolve } from "node:path";

const root = import.meta.dir;
const modulePath = "dist/gguf/insights/GgufInsights.js";
const original = await Bun.file(`${root}/original/${modulePath}`).text();
const upstream = await Bun.file(`${root}/upstream-GgufInsights.ts`).text();
const start = "export class GgufInsightsSimulatorSession";
const end = "function parseTensorName";
let section = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
  upstream.slice(upstream.indexOf(start), upstream.indexOf(end))
);
section = section.replaceAll("!0", "true").replaceAll("!1", "false");
section = section.replaceAll("registerFinalizer(", "registerSimulatorFinalizer(");
section = section.replace(
  "  _disposeAggregator = new AsyncDisposeAggregator;",
  "  _disposeAggregator = new AsyncDisposeAggregator;\n  _disposal;"
);
section = section.replace(
  "  async dispose() {\n    await this._disposeAggregator.dispose();\n  }",
  "  dispose() {\n    return this._disposal ??= this._disposeAggregator.dispose();\n  }"
);
// The same handle-construction failure must release its raw native model. Neither
// the old native Napi wrapper nor backend guard substitutes for explicit cleanup.
section = section.replace(
  '        throw Error("Failed to load model");\n    } finally {',
  '        throw Error("Failed to load model");\n    } catch (error) {\n      await model.dispose().catch(() => {});\n      throw error;\n    } finally {'
);
section = section.replace(
  "    return new SimulatorModelHandle(this._llama, model);",
  "    try {\n      return new SimulatorModelHandle(this._llama, model);\n    } catch (error) {\n      await model.dispose().catch(() => {});\n      throw error;\n    }"
);
section += `
// Compatibility backport: lifecycle-utils 3.1.1 has no registerFinalizer export.
// Native FinalizationRegistry preserves upstream weak ownership without a dep bump.
const simulatorFinalizers = new FinalizationRegistry((target) => {
  try { Promise.resolve(target.dispose()).catch(() => {}); } catch {}
});
function registerSimulatorFinalizer(target, disposable) {
  const token = {};
  simulatorFinalizers.register(target, disposable, token);
  return () => simulatorFinalizers.unregister(token);
}

`;
let patched = original.slice(0, original.indexOf(start)) + section + original.slice(original.indexOf(end));
patched = patched.replace("//# sourceMappingURL=GgufInsights.js.map", "// Simulator lifetime backport: omit the now-stale upstream source map.");
patched = patched.replace(
  'import { acquireLock, withLock } from "lifecycle-utils";',
  'import { acquireLock, AsyncDisposeAggregator, withLock } from "lifecycle-utils";\nimport { DisposeGuard } from "../../utils/DisposeGuard.js";'
);
await Bun.write(`${root}/patched/${modulePath}`, patched);

// Compile precisely the changed class region with real, native-free dependencies.
// Unrelated GgufInsights imports would initialize the native module graph.
const dependency = (file: string) => JSON.stringify(new URL(`file://${resolve(root, "../../node_modules/node-llama-cpp/dist", file)}`).href);
const prefix = `
import {acquireLock, AsyncDisposeAggregator, withLock} from "lifecycle-utils";
import bytes from "bytes";
import {DisposeGuard} from ${dependency("utils/DisposeGuard.js")};
import {LruCache} from ${dependency("utils/LruCache.js")};
import {removeNullFields,removeUndefinedFields} from ${dependency("utils/removeNullFields.js")};
import {doesLlamaBackendNeedAddonInitLock,LlamaLocks,LlamaLogLevel} from ${dependency("bindings/types.js")};
const GgmlType={F16:1};
`;
for (const [side, content] of [["original", original], ["patched", patched]]) {
  await Bun.write(`${root}/${side}-fixture.js`, prefix + content.slice(content.indexOf(start), content.indexOf(end)));
}
console.log("Prepared simulator-only JavaScript backport and isolated class fixtures.");
