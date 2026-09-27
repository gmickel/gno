/**
 * Worker entry for budgeted document conversion (fn-198).
 *
 * Runs one conversion through the default pipeline off the main thread, so
 * the parent can terminate it when it overruns its time or memory budget.
 * Synchronous converter work (DOM building, HTML-to-Markdown) cannot be
 * interrupted in-process; a terminated worker stops mid-loop and releases
 * its heap.
 *
 * @module src/converters/convert-worker
 */

import type { ConvertInput, PipelineResult } from "./types";

import { getDefaultPipeline } from "./pipeline";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<ConvertInput>) => {
  const result: PipelineResult = await getDefaultPipeline().convert(event.data);
  self.postMessage(result);
};
