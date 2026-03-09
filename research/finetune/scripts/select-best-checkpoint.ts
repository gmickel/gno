#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  selectBestValCheckpoint,
  summarizeCheckpoint,
} from "../lib/run-selection";

const runName = process.argv[2] ?? "mlx-run1";
const outputsDir = join(import.meta.dir, "../outputs");
const logsDir = join(outputsDir, "logs");

const logFiles = [...new Bun.Glob(`${runName}-*.log`).scanSync(logsDir)].sort();
const latestLog = logFiles.at(-1);
if (!latestLog) {
  throw new Error(`No log found for run ${runName}`);
}

const logPath = join(logsDir, latestLog);
const adapterDir = join(outputsDir, runName);
const logText = await Bun.file(logPath).text();
const best = selectBestValCheckpoint(logText, adapterDir);
if (!best) {
  throw new Error(`No val checkpoints parsed from ${logPath}`);
}
if (best.adapterFile && !existsSync(best.adapterFile)) {
  throw new Error(`Best checkpoint file missing: ${best.adapterFile}`);
}

const summary = {
  runName,
  logPath,
  adapterDir,
  best,
};

const outPath = join(adapterDir, "best-checkpoint.json");
await Bun.write(outPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(summarizeCheckpoint(best));
console.log(outPath);
