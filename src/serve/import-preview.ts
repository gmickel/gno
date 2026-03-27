// node:fs/promises readdir: no Bun recursive directory API with this shape
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Config } from "../config/types";

export interface ImportPreview {
  path: string;
  suggestedName: string;
  folderType: "obsidian-vault" | "notes-folder" | "mixed-docs" | "binary-heavy";
  counts: {
    markdown: number;
    text: number;
    pdf: number;
    office: number;
    other: number;
    folders: number;
    scannedFiles: number;
    truncated: boolean;
  };
  signals: string[];
  guidance: string[];
  conflicts: string[];
}

const PREVIEW_FILE_LIMIT = 400;

function extname(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

export async function analyzeImportPath(
  config: Config,
  path: string,
  name?: string
): Promise<ImportPreview> {
  const suggestedName = (name || basename(path)).toLowerCase();
  const counts = {
    markdown: 0,
    text: 0,
    pdf: 0,
    office: 0,
    other: 0,
    folders: 0,
    scannedFiles: 0,
    truncated: false,
  };
  const signals = new Set<string>();
  const guidance: string[] = [];
  const conflicts: string[] = [];
  const queue = [path];

  if (
    config.collections.some((collection) => collection.name === suggestedName)
  ) {
    conflicts.push(`Collection name "${suggestedName}" already exists.`);
  }
  const samePath = config.collections.find(
    (collection) => collection.path === path
  );
  if (samePath) {
    conflicts.push(`This folder is already indexed as "${samePath.name}".`);
  }

  while (queue.length > 0 && counts.scannedFiles < PREVIEW_FILE_LIMIT) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      if (counts.scannedFiles >= PREVIEW_FILE_LIMIT) {
        counts.truncated = true;
        break;
      }

      if (entry.isDirectory()) {
        counts.folders += 1;
        if (entryName === ".obsidian") {
          signals.add("Obsidian config detected");
        }
        if (entryName === ".git") {
          signals.add("Git repo detected");
        }
        if (!entryName.startsWith(".")) {
          queue.push(join(current, entryName));
        }
        continue;
      }

      counts.scannedFiles += 1;
      const ext = extname(entryName);
      if (ext === ".md") {
        counts.markdown += 1;
        continue;
      }
      if (ext === ".txt") {
        counts.text += 1;
        continue;
      }
      if (ext === ".pdf") {
        counts.pdf += 1;
        continue;
      }
      if ([".docx", ".pptx", ".xlsx"].includes(ext)) {
        counts.office += 1;
        continue;
      }
      counts.other += 1;
    }
  }

  const noteLikeCount = counts.markdown + counts.text;
  const binaryCount = counts.pdf + counts.office;

  let folderType: ImportPreview["folderType"] = "mixed-docs";
  if (signals.has("Obsidian config detected")) {
    folderType = "obsidian-vault";
  } else if (
    noteLikeCount > 0 &&
    binaryCount === 0 &&
    counts.other < noteLikeCount
  ) {
    folderType = "notes-folder";
  } else if (binaryCount > noteLikeCount) {
    folderType = "binary-heavy";
  }

  if (folderType === "obsidian-vault") {
    guidance.push(
      "GNO will index your vault files and wiki links, but it does not replace the Obsidian plugin ecosystem."
    );
  }
  if (binaryCount > 0) {
    guidance.push(
      "PDF, DOCX, PPTX, and XLSX files are imported as searchable read-only source material."
    );
  }
  if (counts.other > noteLikeCount && counts.other > 10) {
    guidance.push(
      "This folder has a lot of unsupported or non-document files. Consider narrowing the pattern or excludes before indexing."
    );
  }
  if (counts.truncated) {
    guidance.push(
      "Preview is sampled from the first few hundred files, not a full recursive inventory."
    );
  }
  if (guidance.length === 0) {
    guidance.push(
      "This folder looks straightforward to import with the current defaults."
    );
  }

  return {
    path,
    suggestedName,
    folderType,
    counts,
    signals: [...signals],
    guidance,
    conflicts,
  };
}
