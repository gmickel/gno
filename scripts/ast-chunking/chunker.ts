import goWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm";
import javascriptWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm";
import pythonWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm";
import rustWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm";
import tsxWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm";
import typescriptWasm from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm";
// node:path for extension detection only.
import { extname } from "node:path";
import {
  Language,
  type Language as TreeSitterLanguage,
  type Node as TreeSitterNode,
  Parser,
} from "web-tree-sitter";
import parserWasm from "web-tree-sitter/web-tree-sitter.wasm";

import type { ChunkOutput, ChunkParams } from "../../src/ingestion/types";

import { MarkdownChunker } from "../../src/ingestion/chunker";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CHUNK_PARAMS,
  type ChunkingResult,
  type SupportedAstLanguage,
} from "./types";

const CODE_EXTENSIONS: Record<string, SupportedAstLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

const GRAMMAR_WASM: Record<SupportedAstLanguage, string> = {
  typescript: typescriptWasm,
  tsx: tsxWasm,
  javascript: javascriptWasm,
  jsx: javascriptWasm,
  python: pythonWasm,
  go: goWasm,
  rust: rustWasm,
};

const STRUCTURAL_NODE_TYPES = new Set([
  "class_declaration",
  "decorated_definition",
  "enum_declaration",
  "export_statement",
  "function_declaration",
  "function_definition",
  "impl_item",
  "import_declaration",
  "import_from_statement",
  "import_statement",
  "interface_declaration",
  "lexical_declaration",
  "method_definition",
  "struct_item",
  "trait_item",
  "type_alias_declaration",
  "type_declaration",
]);

const heuristicChunker = new MarkdownChunker();
const languageCache = new Map<
  SupportedAstLanguage,
  Promise<TreeSitterLanguage>
>();
let treeSitterInitialized = false;

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function nowMs(): number {
  return performance.now();
}

function detectLanguage(sourcePath: string): SupportedAstLanguage | null {
  return CODE_EXTENSIONS[extname(sourcePath).toLowerCase()] ?? null;
}

function createLineIndex(text: string): number[] {
  const newlines: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      newlines.push(index);
    }
  }
  return newlines;
}

function lineAtPosition(newlines: number[], pos: number): number {
  let low = 0;
  let high = newlines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const value = newlines[mid];
    if (value !== undefined && value < pos) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low + 1;
}

function toOutputChunk(
  text: string,
  pos: number,
  seq: number,
  lineIndex: number[],
  language: string
): ChunkOutput {
  return {
    seq,
    pos,
    text,
    startLine: lineAtPosition(lineIndex, pos),
    endLine: lineAtPosition(lineIndex, Math.max(pos, pos + text.length - 1)),
    language,
    tokenCount: null,
  };
}

async function ensureTreeSitterInitialized(): Promise<void> {
  if (treeSitterInitialized) {
    return;
  }
  await Parser.init({
    locateFile() {
      return parserWasm;
    },
  });
  treeSitterInitialized = true;
}

async function loadLanguage(
  language: SupportedAstLanguage
): Promise<TreeSitterLanguage> {
  const cached = languageCache.get(language);
  if (cached) {
    return cached;
  }
  const promise = Language.load(GRAMMAR_WASM[language]);
  languageCache.set(language, promise);
  return promise;
}

function structuralBreaksFromTree(
  text: string,
  root: TreeSitterNode,
  maxChars: number
): number[] {
  const breaks = new Set<number>();
  const visit = (node: TreeSitterNode, depth: number): void => {
    const span = node.endIndex - node.startIndex;
    if (
      node.startIndex > 0 &&
      span >= Math.floor(maxChars * 0.12) &&
      (depth <= 1 || STRUCTURAL_NODE_TYPES.has(node.type))
    ) {
      breaks.add(node.startIndex);
    }
    if (depth > 4) {
      return;
    }
    for (const child of node.namedChildren) {
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return [...breaks]
    .filter((point) => point > 0 && point < text.length)
    .sort((a, b) => a - b);
}

function chunkByBreaks(
  text: string,
  sourcePath: string,
  language: SupportedAstLanguage,
  breaks: number[],
  params: ChunkParams
): ChunkOutput[] {
  const maxChars = (params.maxTokens ?? 220) * CHARS_PER_TOKEN;
  const lineIndex = createLineIndex(text);
  const sortedBreaks = [0, ...breaks, text.length]
    .filter(
      (point, index, values) => point >= 0 && values.indexOf(point) === index
    )
    .sort((a, b) => a - b);
  const chunks: ChunkOutput[] = [];
  let seq = 0;
  let start = 0;

  const pushHeuristicSlice = (sliceStart: number, sliceEnd: number): void => {
    const sliceText = text.slice(sliceStart, sliceEnd);
    for (const chunk of heuristicChunker.chunk(
      sliceText,
      params,
      language,
      sourcePath
    )) {
      chunks.push({
        ...chunk,
        seq,
        pos: sliceStart + chunk.pos,
        startLine: lineAtPosition(lineIndex, sliceStart + chunk.pos),
        endLine: lineAtPosition(
          lineIndex,
          sliceStart + chunk.pos + chunk.text.length - 1
        ),
      });
      seq += 1;
    }
  };

  for (const boundary of sortedBreaks.slice(1)) {
    if (boundary - start > maxChars && boundary !== text.length) {
      if (boundary - start > maxChars * 1.35) {
        pushHeuristicSlice(start, boundary);
      } else {
        chunks.push(
          toOutputChunk(
            text.slice(start, boundary),
            start,
            seq,
            lineIndex,
            language
          )
        );
        seq += 1;
      }
      start = boundary;
    }
  }

  if (start < text.length) {
    if (text.length - start > maxChars * 1.35) {
      pushHeuristicSlice(start, text.length);
    } else {
      chunks.push(
        toOutputChunk(text.slice(start), start, seq, lineIndex, language)
      );
    }
  }

  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

export async function chunkWithTreeSitterFallback(
  text: string,
  sourcePath: string,
  params: ChunkParams = DEFAULT_CHUNK_PARAMS
): Promise<ChunkingResult> {
  const start = nowMs();
  const language = detectLanguage(sourcePath);
  if (!language) {
    const chunkStart = nowMs();
    return {
      chunks: heuristicChunker.chunk(text, params, undefined, sourcePath),
      stats: {
        usedAst: false,
        unsupported: true,
        parseError: false,
        parseMs: 0,
        chunkMs: round(nowMs() - chunkStart, 2),
      },
    };
  }

  try {
    await ensureTreeSitterInitialized();
    const parser = new Parser();
    parser.setLanguage(await loadLanguage(language));
    const tree = parser.parse(text);
    const parseMs = nowMs() - start;
    if (!tree || tree.rootNode.hasError) {
      parser.delete();
      const chunkStart = nowMs();
      return {
        chunks: heuristicChunker.chunk(text, params, language, sourcePath),
        stats: {
          usedAst: false,
          unsupported: false,
          parseError: true,
          parseMs: round(parseMs, 2),
          chunkMs: round(nowMs() - chunkStart, 2),
        },
      };
    }

    const maxChars = (params.maxTokens ?? 220) * CHARS_PER_TOKEN;
    const breaks = structuralBreaksFromTree(text, tree.rootNode, maxChars);
    const chunkStart = nowMs();
    const chunks = chunkByBreaks(text, sourcePath, language, breaks, params);
    parser.delete();
    return {
      chunks,
      stats: {
        usedAst: true,
        unsupported: false,
        parseError: false,
        parseMs: round(parseMs, 2),
        chunkMs: round(nowMs() - chunkStart, 2),
      },
    };
  } catch {
    const chunkStart = nowMs();
    return {
      chunks: heuristicChunker.chunk(text, params, language, sourcePath),
      stats: {
        usedAst: false,
        unsupported: false,
        parseError: true,
        parseMs: round(nowMs() - start, 2),
        chunkMs: round(nowMs() - chunkStart, 2),
      },
    };
  }
}
