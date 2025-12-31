/**
 * MCP gno_get tool - Retrieve single document.
 *
 * @module src/mcp/tools/get
 */

import { join as pathJoin } from 'node:path';
import { parseUri } from '../../app/constants';
import { parseRef } from '../../cli/commands/ref-parser';
import type { DocumentRow, StorePort } from '../../store/types';
import type { ToolContext } from '../server';
import { runTool, type ToolResult } from './index';

interface GetInput {
  ref: string;
  fromLine?: number;
  lineCount?: number;
  lineNumbers?: boolean;
}

interface GetResponse {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  totalLines: number;
  returnedLines?: { start: number; end: number };
  language?: string;
  source: {
    absPath?: string;
    relPath: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
    sourceHash?: string;
  };
  conversion?: {
    converterId?: string;
    converterVersion?: string;
    mirrorHash?: string;
  };
}

/**
 * Lookup document by parsed reference.
 */
async function lookupDocument(
  store: StorePort,
  parsed: ReturnType<typeof parseRef>
): Promise<DocumentRow | null> {
  if ('error' in parsed) {
    return null;
  }

  switch (parsed.type) {
    case 'docid': {
      const result = await store.getDocumentByDocid(parsed.value);
      return result.ok ? result.value : null;
    }
    case 'uri': {
      const result = await store.getDocumentByUri(parsed.value);
      return result.ok ? result.value : null;
    }
    case 'collPath': {
      if (!(parsed.collection && parsed.relPath)) {
        return null;
      }
      const result = await store.getDocument(parsed.collection, parsed.relPath);
      return result.ok ? result.value : null;
    }
    default:
      return null;
  }
}

/**
 * Format get response as text.
 */
function formatGetResponse(data: GetResponse): string {
  const lines: string[] = [];

  lines.push(`Document: ${data.uri}`);
  if (data.title) {
    lines.push(`Title: ${data.title}`);
  }
  lines.push(`Lines: ${data.totalLines}`);
  if (data.source.absPath) {
    lines.push(`Path: ${data.source.absPath}`);
  }
  lines.push('');

  if (data.returnedLines) {
    lines.push(
      `--- Content (lines ${data.returnedLines.start}-${data.returnedLines.end}) ---`
    );
  } else {
    lines.push('--- Content ---');
  }

  lines.push(data.content);

  return lines.join('\n');
}

/**
 * Handle gno_get tool call.
 */
export function handleGet(
  args: GetInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    'gno_get',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: document retrieval with multiple ref formats and chunk handling
    async () => {
      // Parse reference
      const parsed = parseRef(args.ref);
      if ('error' in parsed) {
        throw new Error(parsed.error);
      }

      // Lookup document
      const doc = await lookupDocument(ctx.store, parsed);
      if (!doc) {
        throw new Error(`Document not found: ${args.ref}`);
      }

      // Get content
      if (!doc.mirrorHash) {
        throw new Error('Document has no indexed content');
      }

      const contentResult = await ctx.store.getContent(doc.mirrorHash);
      if (!contentResult.ok) {
        throw new Error(contentResult.error.message);
      }

      const fullContent = contentResult.value ?? '';
      const contentLines = fullContent.split('\n');
      const totalLines = contentLines.length;

      // Apply line range if specified
      let content = fullContent;
      let returnedLines: { start: number; end: number } | undefined;

      // lineNumbers defaults to true per spec
      const showLineNumbers = args.lineNumbers !== false;

      if (args.fromLine || args.lineCount) {
        const startLine = args.fromLine ?? 1;
        // Clamp startLine to valid range
        if (startLine > totalLines) {
          // Return empty content for out-of-range request
          content = '';
          returnedLines = undefined;
        } else {
          const count = args.lineCount ?? totalLines - startLine + 1;
          const endLine = Math.min(startLine + count - 1, totalLines);

          const slicedLines = contentLines.slice(startLine - 1, endLine);

          if (showLineNumbers) {
            content = slicedLines
              .map((line, i) => `${startLine + i}: ${line}`)
              .join('\n');
          } else {
            content = slicedLines.join('\n');
          }

          returnedLines = { start: startLine, end: endLine };
        }
      } else if (showLineNumbers) {
        content = contentLines.map((line, i) => `${i + 1}: ${line}`).join('\n');
      }

      // Build absPath
      const uriParsed = parseUri(doc.uri);
      let absPath: string | undefined;
      if (uriParsed) {
        const collection = ctx.collections.find(
          (c) => c.name === uriParsed.collection
        );
        if (collection) {
          absPath = pathJoin(collection.path, doc.relPath);
        }
      }

      const response: GetResponse = {
        docid: doc.docid,
        uri: doc.uri,
        title: doc.title ?? undefined,
        content,
        totalLines,
        returnedLines,
        language: doc.languageHint ?? undefined,
        source: {
          absPath,
          relPath: doc.relPath,
          mime: doc.sourceMime,
          ext: doc.sourceExt,
          modifiedAt: doc.sourceMtime,
          sizeBytes: doc.sourceSize,
          sourceHash: doc.sourceHash,
        },
        conversion: doc.mirrorHash
          ? {
              converterId: doc.converterId ?? undefined,
              converterVersion: doc.converterVersion ?? undefined,
              mirrorHash: doc.mirrorHash,
            }
          : undefined,
      };

      return response;
    },
    formatGetResponse
  );
}
