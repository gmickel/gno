/**
 * MCP resource registration for gno:// URIs.
 *
 * @module src/mcp/resources
 */

import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { join as pathJoin } from "node:path";

import type { DocumentRow, TagCount } from "../../store/types";
import type { ToolContext } from "../server";

import { buildUri, parseUri, URI_PREFIX } from "../../app/constants";
import { MCP_ERRORS } from "../../core/errors";
import { normalizeTag, validateTag } from "../../core/tags";
import { normalizeCollectionName } from "../../core/validation";

// Tags resource URI prefix
const TAGS_URI = `${URI_PREFIX}tags`;

/**
 * Format tag list as JSON for MCP resource content.
 */
function formatTagsContent(
  tags: TagCount[],
  collection?: string,
  prefix?: string
): string {
  const result = {
    tags,
    meta: {
      collection: collection || undefined,
      prefix: prefix || undefined,
      totalTags: tags.length,
    },
  };
  return JSON.stringify(result, null, 2);
}

/**
 * Format document content with header comment and line numbers.
 */
function formatResourceContent(
  doc: DocumentRow,
  content: string,
  ctx: ToolContext
): string {
  // Find collection for absPath
  const uriParsed = parseUri(doc.uri);
  let absPath = doc.relPath;
  if (uriParsed) {
    const collection = ctx.collections.find(
      (c) => c.name === uriParsed.collection
    );
    if (collection) {
      absPath = pathJoin(collection.path, doc.relPath);
    }
  }

  // Header comment per spec (includes language if available)
  const langLine = doc.languageHint
    ? `\n     language: ${doc.languageHint}`
    : "";
  const header = `<!-- ${doc.uri}
     docid: ${doc.docid}
     source: ${absPath}
     mime: ${doc.sourceMime}${langLine}
-->

`;

  // Line numbers per spec (default ON for agent friendliness)
  const lines = content.split("\n");
  const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join("\n");

  return header + numbered;
}

/**
 * Register gno:// resources with the MCP server.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  // Resource template for gno://{collection}/{path} URIs
  const template = new ResourceTemplate(`${URI_PREFIX}{collection}/{+path}`, {
    list: async () => {
      // List all documents as resources
      const listResult = await ctx.store.listDocuments();
      if (!listResult.ok) {
        return { resources: [] };
      }

      return {
        resources: listResult.value.map((doc) => ({
          uri: doc.uri,
          name: doc.relPath,
          mimeType: doc.sourceMime || "text/markdown",
          description: doc.title ?? undefined,
        })),
      };
    },
  });

  // Register the template-based resource handler
  server.resource("gno-document", template, {}, async (uri, _variables) => {
    // Check shutdown before acquiring mutex
    if (ctx.isShuttingDown()) {
      throw new Error("Server is shutting down");
    }

    // Serialize resource reads same as tools (prevent concurrent DB access + shutdown race)
    const release = await ctx.toolMutex.acquire();
    try {
      // Use parseUri for proper URL decoding (handles %20, etc.)
      const parsed = parseUri(uri.href);
      if (!parsed) {
        throw new Error(`Invalid gno:// URI: ${uri.href}`);
      }

      const { collection, path } = parsed;

      // Validate collection exists
      const collectionExists = ctx.collections.some(
        (c) => c.name === collection
      );
      if (!collectionExists) {
        throw new Error(`Collection not found: ${collection}`);
      }

      // Look up document (path is properly decoded by parseUri)
      const docResult = await ctx.store.getDocument(collection, path);
      if (!docResult.ok) {
        throw new Error(
          `Failed to lookup document: ${docResult.error.message}`
        );
      }

      const doc = docResult.value;
      if (!doc) {
        throw new Error(`Document not found: ${uri.href}`);
      }

      // Get content
      if (!doc.mirrorHash) {
        throw new Error(`Document has no indexed content: ${uri.href}`);
      }

      const contentResult = await ctx.store.getContent(doc.mirrorHash);
      if (!contentResult.ok) {
        throw new Error(
          `Failed to read content: ${contentResult.error.message}`
        );
      }

      const content = contentResult.value ?? "";

      // Format with header and line numbers
      const formattedContent = formatResourceContent(doc, content, ctx);

      // Build canonical URI
      const canonicalUri = buildUri(collection, path);

      return {
        contents: [
          {
            uri: canonicalUri,
            mimeType: "text/markdown",
            text: formattedContent,
          },
        ],
      };
    } finally {
      release();
    }
  });

  // Register gno://tags resource for listing tags
  // Use ResourceTemplate with RFC6570 query expansion for proper routing
  const tagsTemplate = new ResourceTemplate(
    `${URI_PREFIX}tags{?collection,prefix}`,
    {
      list: async () => ({
        resources: [
          {
            uri: TAGS_URI,
            name: "tags",
            mimeType: "application/json",
            description: "List all tags with document counts",
          },
        ],
      }),
    }
  );

  server.resource(
    "gno-tags",
    tagsTemplate,
    { mimeType: "application/json" },
    async (uri) => {
      // Check shutdown before acquiring mutex
      if (ctx.isShuttingDown()) {
        throw new Error("Server is shutting down");
      }

      const release = await ctx.toolMutex.acquire();
      try {
        // Parse query params from URI
        const url = new URL(uri.href);
        const collectionParam = url.searchParams.get("collection") || undefined;
        const prefixParam = url.searchParams.get("prefix") || undefined;

        // Normalize and validate collection (case-insensitive)
        let collection: string | undefined;
        if (collectionParam) {
          collection = normalizeCollectionName(collectionParam);
          const exists = ctx.collections.some(
            (c) => c.name.toLowerCase() === collection
          );
          if (!exists) {
            throw new Error(
              `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${collectionParam}`
            );
          }
        }

        // Normalize and validate prefix
        let prefix: string | undefined;
        if (prefixParam) {
          const trimmed = prefixParam.trim().replace(/\/+$/, "");
          if (trimmed.length > 0) {
            prefix = normalizeTag(trimmed);
            if (!validateTag(prefix)) {
              throw new Error(
                `${MCP_ERRORS.INVALID_INPUT.code}: Invalid tag prefix "${prefixParam}"`
              );
            }
          }
        }

        // Get tag counts
        const result = await ctx.store.getTagCounts({ collection, prefix });
        if (!result.ok) {
          throw new Error(`Failed to get tags: ${result.error.message}`);
        }

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: formatTagsContent(result.value, collection, prefix),
            },
          ],
        };
      } finally {
        release();
      }
    }
  );
}
