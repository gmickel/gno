/**
 * Text renderings of session receipts and status, shared by every text
 * surface (CLI terminal output, MCP text content).
 *
 * @module src/sessions/format
 */

import type { SessionImportReceipt, SessionsStatus } from "./types";

/** Plain-text import receipt shared by the CLI and MCP. */
export function formatImportReceiptText(receipt: SessionImportReceipt): string {
  const c = receipt.counts;
  const lines = [
    `Session import ${receipt.dryRun ? "(dry run, nothing written) " : ""}${receipt.status}`,
    `threads: ${c.imported} imported, ${c.updated} updated, ${c.unchanged} unchanged, ${c.skippedPolicy} skipped by policy`,
    `units: ${c.incomplete} incomplete, ${c.failed} failed, ${c.unsupported} unsupported${receipt.deferredUnits > 0 ? `, ${receipt.deferredUnits} deferred by limit` : ""}`,
    `turns: ${receipt.turns.human} human, ${receipt.turns.assistant} assistant, ${receipt.turns.redactions} redactions, ${receipt.turns.injectedSkipped} injected skipped`,
    `lexical: ${receipt.lexical.status}${receipt.lexical.error ? ` (${receipt.lexical.error})` : ""}; embedding backlog: ${receipt.embedding.backlog ?? "n/a"}`,
  ];
  const notable = receipt.units.filter(
    (unit) =>
      unit.outcome !== "unchanged" &&
      unit.outcome !== "imported" &&
      unit.outcome !== "updated"
  );
  for (const unit of notable.slice(0, 20)) {
    lines.push(
      `- ${unit.sourceId} ${unit.locator}: ${unit.outcome}${unit.reason ? ` (${unit.reason})` : ""}`
    );
  }
  for (const warning of receipt.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

/** Plain-text archive status shared by the CLI and MCP. */
export function formatStatusText(status: SessionsStatus): string {
  const lines = [`Session archive (index ${status.index})`];
  for (const collection of status.collections) {
    lines.push(
      `- collection ${collection.name}: ${collection.threads} threads`
    );
  }
  for (const source of status.sources) {
    lines.push(
      `- source ${source.id} (${source.harness} -> ${source.collection}): ${source.available ? "available" : "UNAVAILABLE"}; units ${source.units.complete} complete, ${source.units.incomplete} incomplete, ${source.units.failed} failed, ${source.units.pending} pending; last import ${source.lastImportAt ?? "never"}`
    );
    if (source.sourceUnavailable > 0) {
      lines.push(
        `  ${source.sourceUnavailable} archived units no longer have a source (archive retained${source.staleParser > 0 ? `, ${source.staleParser} from an older parser` : ""})`
      );
    }
  }
  for (const warning of status.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
