import { basename, join } from "node:path";

export interface ValCheckpointRecord {
  iteration: number;
  valLoss: number;
  adapterFile?: string;
}

const VAL_LOSS_PATTERN = /Iter (\d+): Val loss ([0-9.]+)/g;

export function parseValLossRecords(logText: string): ValCheckpointRecord[] {
  const records: ValCheckpointRecord[] = [];
  for (const match of logText.matchAll(VAL_LOSS_PATTERN)) {
    const iteration = Number(match[1]);
    const valLoss = Number(match[2]);
    if (!Number.isFinite(iteration) || !Number.isFinite(valLoss)) {
      continue;
    }
    records.push({ iteration, valLoss });
  }
  return records;
}

export function selectBestValCheckpoint(
  logText: string,
  adapterDir: string
): ValCheckpointRecord | null {
  const records = parseValLossRecords(logText);
  if (records.length === 0) {
    return null;
  }

  let best: ValCheckpointRecord | null = null;
  for (const record of records) {
    const adapterFile = join(
      adapterDir,
      `${record.iteration.toString().padStart(7, "0")}_adapters.safetensors`
    );
    const enriched = { ...record, adapterFile };
    if (
      !best ||
      enriched.valLoss < best.valLoss ||
      (enriched.valLoss === best.valLoss && enriched.iteration < best.iteration)
    ) {
      best = enriched;
    }
  }
  return best;
}

export function summarizeCheckpoint(record: ValCheckpointRecord | null): string {
  if (!record) {
    return "no checkpoint";
  }
  return `${record.iteration} (${record.valLoss.toFixed(3)}) ${record.adapterFile ? basename(record.adapterFile) : ""}`.trim();
}
