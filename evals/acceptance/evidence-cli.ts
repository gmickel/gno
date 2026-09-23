/** Development entrypoint; neither shipped public CLI nor default CI workload. */
import { atomicCreate } from "../../src/core/file-ops";
import { evaluateEvidenceRun } from "./evidence";
import { loadEvidenceFixtures } from "./evidence-fixtures";

export async function runEvidenceCommand(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help")) {
    console.log(
      "bun evals/acceptance/evidence-cli.ts --input <observations.json> --output <new-report.json>\nGNO_LLAMA_GPU=cuda GNO_LLAMA_BUILD=never bun evals/acceptance/evidence-cli.ts --native --output <new-directory>\nNo model downloads. Replay never certifies native execution."
    );
    console.log(
      "Use GNO_LLAMA_GPU=false for an explicitly CPU-only native screen; it never certifies CUDA or Metal."
    );
    return 0;
  }
  const native = args[0] === "--native";
  if (
    native
      ? args.length !== 3 || args[1] !== "--output"
      : args.length !== 4 || args[0] !== "--input" || args[2] !== "--output"
  )
    throw new Error(
      "Expected --input FILE --output FILE, or --native --output DIRECTORY"
    );
  const { fixtures } = await loadEvidenceFixtures();
  const report = native
    ? await (
        await import("./evidence-native")
      ).runNativeEvidenceScreen(args[2]!)
    : evaluateEvidenceRun(fixtures, await Bun.file(args[1]!).json());
  if (!native)
    await atomicCreate(args[3]!, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      kind: report.kind,
      valid: report.valid,
      passed: report.passed,
      baselineMisses: report.paired.filter((p) => p.baselineMiss).length,
      candidateMisses: report.paired.filter((p) => p.candidateMiss).length,
    })
  );
  return report.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await runEvidenceCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
