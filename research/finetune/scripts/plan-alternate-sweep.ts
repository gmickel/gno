#!/usr/bin/env bun
import { join } from "node:path";

const configPath = join(
  import.meta.dir,
  "../configs/alternate-base-sweep.json"
);

const config = (await Bun.file(configPath).json()) as {
  id: string;
  defaultWinner: {
    baseModel: string;
    runtimeModelUri: string;
  };
  alternates: Array<{
    family: string;
    reasonToTry: string;
    priority: number;
  }>;
  decisionRules: {
    stayOnWinnerWhen: string[];
    runAlternateSweepWhen: string[];
  };
};

console.log(`# ${config.id}\n`);
console.log(`Current winner: ${config.defaultWinner.baseModel}`);
console.log(`Runtime URI: ${config.defaultWinner.runtimeModelUri}\n`);
console.log("When to keep rerunning the current winner:");
for (const rule of config.decisionRules.stayOnWinnerWhen) {
  console.log(`- ${rule}`);
}

console.log("\nWhen to run an alternate-base sweep:");
for (const rule of config.decisionRules.runAlternateSweepWhen) {
  console.log(`- ${rule}`);
}

console.log("\nAlternate candidates:");
for (const candidate of [...config.alternates].sort(
  (a, b) => a.priority - b.priority
)) {
  console.log(
    `- [P${candidate.priority}] ${candidate.family}: ${candidate.reasonToTry}`
  );
}
