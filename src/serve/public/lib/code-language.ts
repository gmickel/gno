import { bundledLanguages, type BundledLanguage } from "shiki";

export type CodeLanguage = BundledLanguage | "text";

const LANGUAGE_CLASS_PATTERN = /language-([A-Za-z0-9_+-]+)/;

const LANGUAGE_ALIASES = {
  cjs: "javascript",
  js: "javascript",
  md: "markdown",
  mts: "typescript",
  plain: "text",
  plaintext: "text",
  py: "python",
  shell: "bash",
  tasks: "markdown",
  text: "text",
  ts: "typescript",
  txt: "text",
  yml: "yaml",
  zsh: "bash",
} as const satisfies Record<string, CodeLanguage>;

export function extractMarkdownCodeLanguage(
  className: string | undefined
): string {
  return className?.match(LANGUAGE_CLASS_PATTERN)?.[1]?.toLowerCase() ?? "text";
}

export function resolveCodeLanguage(
  language: string | null | undefined
): CodeLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) {
    return "text";
  }

  const aliased =
    LANGUAGE_ALIASES[normalized as keyof typeof LANGUAGE_ALIASES] ?? normalized;
  if (aliased === "text") {
    return "text";
  }

  if (aliased in bundledLanguages) {
    return aliased as BundledLanguage;
  }

  return "text";
}
