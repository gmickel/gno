/**
 * MCP gno_multi_get tool - Retrieve multiple documents.
 *
 * @module src/mcp/tools/multi-get
 */

import { join as pathJoin } from 'node:path';
import { parseUri } from '../../app/constants';
import { parseRef } from '../../cli/commands/ref-parser';
import type { DocumentRow, StorePort } from '../../store/types';
import type { ToolContext } from '../server';
import { runTool, type ToolResult } from './index';

interface MultiGetInput {
  refs?: string[];
  pattern?: string;
  maxBytes?: number;
  lineNumbers?: boolean; // defaults to true per spec
}

interface DocumentResult {
  docid: string;
  uri: string;
  title?: string;
  content: string;
  totalLines: number;
  truncated: boolean;
  source: {
    absPath?: string;
    relPath: string;
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
  };
}

interface MultiGetResponse {
  documents: DocumentResult[];
  skipped: Array<{ ref: string; reason: string }>;
  meta: {
    requested: number;
    returned: number;
    skipped: number;
  };
}

// Default per spec is 10240
const DEFAULT_MAX_BYTES = 10_240;

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
 * Format multi-get response as text.
 */
function formatMultiGetResponse(data: MultiGetResponse): string {
  const lines: string[] = [];

  lines.push(
    `Retrieved ${data.meta.returned}/${data.meta.requested} documents`
  );
  if (data.meta.skipped > 0) {
    lines.push(`Skipped: ${data.meta.skipped}`);
  }
  lines.push('');

  for (const doc of data.documents) {
    lines.push(`=== ${doc.uri} ===`);
    if (doc.title) {
      lines.push(`Title: ${doc.title}`);
    }
    lines.push(
      `Lines: ${doc.totalLines}${doc.truncated ? ' (truncated)' : ''}`
    );
    lines.push('');
    lines.push(doc.content);
    lines.push('');
  }

  if (data.skipped.length > 0) {
    lines.push('--- Skipped ---');
    for (const s of data.skipped) {
      lines.push(`${s.ref}: ${s.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Handle gno_multi_get tool call.
 */
export function handleMultiGet(
  args: MultiGetInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    'gno_multi_get',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: multi-get with pattern expansion and batch retrieval
    async () => {
      // Validate input
      if (!(args.refs || args.pattern)) {
        throw new Error('Either refs or pattern must be provided');
      }
      if (args.refs && args.pattern) {
        throw new Error('Cannot specify both refs and pattern');
      }

      const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
      const documents: DocumentResult[] = [];
      const skipped: Array<{ ref: string; reason: string }> = [];

      let refs: string[] = args.refs ?? [];

      // Pattern-based lookup
      if (args.pattern) {
        // For pattern matching, list all documents and filter
        const listResult = await ctx.store.listDocuments();
        if (!listResult.ok) {
          throw new Error(listResult.error.message);
        }

        // Safe glob-like pattern matching: escape regex metacharacters first
        const pattern = args.pattern;
        // Escape all regex metacharacters except * and ?
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        // Then convert glob wildcards to regex
        const regexPattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
        const regex = new RegExp(`^${regexPattern}$`);

        refs = listResult.value
          .filter((d) => regex.test(d.uri) || regex.test(d.relPath))
          .map((d) => d.uri);
      }

      // Process each reference
      for (const ref of refs) {
        const parsed = parseRef(ref);
        if ('error' in parsed) {
          skipped.push({ ref, reason: parsed.error });
          continue;
        }

        const doc = await lookupDocument(ctx.store, parsed);
        if (!doc) {
          skipped.push({ ref, reason: 'Not found' });
          continue;
        }

        if (!doc.mirrorHash) {
          skipped.push({ ref, reason: 'No indexed content' });
          continue;
        }

        // Get content
        const contentResult = await ctx.store.getContent(doc.mirrorHash);
        if (!contentResult.ok) {
          skipped.push({ ref, reason: contentResult.error.message });
          continue;
        }

        let content = contentResult.value ?? '';
        let truncated = false;

        // Apply maxBytes truncation (actual UTF-8 bytes, not characters)
        const contentBuffer = Buffer.from(content, 'utf8');
        if (contentBuffer.length > maxBytes) {
          // Truncate by bytes, then decode safely (may cut mid-codepoint)
          const truncatedBuffer = contentBuffer.subarray(0, maxBytes);
          // Decode with replacement char for incomplete sequences
          content = truncatedBuffer.toString('utf8');
          // Remove potential trailing replacement char from cut codepoint
          if (content.endsWith('\uFFFD')) {
            content = content.slice(0, -1);
          }
          truncated = true;
        }

        const contentLines = content.split('\n');

        // Apply line numbers (defaults to true per spec)
        if (args.lineNumbers !== false) {
          content = contentLines
            .map((line, i) => `${i + 1}: ${line}`)
            .join('\n');
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

        documents.push({
          docid: doc.docid,
          uri: doc.uri,
          title: doc.title ?? undefined,
          content,
          totalLines: (contentResult.value ?? '').split('\n').length,
          truncated,
          source: {
            absPath,
            relPath: doc.relPath,
            mime: doc.sourceMime,
            ext: doc.sourceExt,
            modifiedAt: doc.sourceMtime,
            sizeBytes: doc.sourceSize,
          },
        });
      }

      const response: MultiGetResponse = {
        documents,
        skipped,
        meta: {
          requested: refs.length,
          returned: documents.length,
          skipped: skipped.length,
        },
      };

      return response;
    },
    formatMultiGetResponse
  );
}
