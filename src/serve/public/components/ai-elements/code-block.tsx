import type { BundledLanguage } from "shiki";
import type { HighlighterCore, ShikiTransformer } from "shiki/types";

import { CheckIcon, CopyIcon } from "lucide-react";
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { resolveCodeLanguage } from "../../lib/code-language";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  highlightedLines?: number[];
  scrollToLine?: number;
};

interface CodeBlockContextType {
  code: string;
}

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

let highlighterPromise: Promise<HighlighterCore> | null = null;
let bundledLanguagesPromise: Promise<
  typeof import("shiki/langs").bundledLanguages
> | null = null;
const loadingLanguages = new Map<string, Promise<void>>();

/**
 * Lazily load shiki/core with only the two themes GNO uses (`one-light` and
 * `one-dark-pro`), keeping Shiki completely off pages without code blocks and
 * dropping ~58 unused bundled themes from the SPA bundle.
 */
function getHighlighterRuntime(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/one-light.mjs"),
    import("shiki/themes/one-dark-pro.mjs"),
  ]).then(([shikiCore, jsEngine, oneLight, oneDarkPro]) =>
    shikiCore.createHighlighterCore({
      engine: jsEngine.createJavaScriptRegexEngine(),
      langs: [],
      themes: [oneLight.default, oneDarkPro.default],
    })
  );
  return highlighterPromise;
}

function getBundledLanguages() {
  bundledLanguagesPromise ??= import("shiki/langs").then(
    (mod) => mod.bundledLanguages
  );
  return bundledLanguagesPromise;
}

async function getHighlighter(
  language: BundledLanguage | "text"
): Promise<HighlighterCore> {
  const highlighter = await getHighlighterRuntime();
  if (
    language === "text" ||
    highlighter.getLoadedLanguages().includes(language)
  ) {
    return highlighter;
  }
  let inflight = loadingLanguages.get(language);
  if (!inflight) {
    inflight = (async () => {
      const langs = await getBundledLanguages();
      const loader = langs[language];
      if (loader) {
        const grammar = await loader();
        await highlighter.loadLanguage(grammar);
      }
    })().finally(() => {
      loadingLanguages.delete(language);
    });
    loadingLanguages.set(language, inflight);
  }
  await inflight;
  return highlighter;
}

function createLineTransformer(
  showLineNumbers: boolean,
  highlightedLines: number[]
): ShikiTransformer {
  const highlighted = new Set(highlightedLines);

  return {
    name: "line-metadata",
    line(node, line) {
      const className = Array.isArray(node.properties.className)
        ? [...node.properties.className]
        : [];
      className.push("gno-code-line");
      if (highlighted.has(line)) {
        className.push(
          "bg-amber-500/12",
          "ring-1",
          "ring-inset",
          "ring-amber-500/25"
        );
      }
      node.properties.className = className;
      node.properties["data-line-number"] = String(line);

      if (!showLineNumbers) {
        return;
      }

      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: {
          className: [
            "inline-block",
            "min-w-10",
            "mr-4",
            "text-right",
            "select-none",
            "text-muted-foreground",
          ],
        },
        children: [{ type: "text", value: String(line) }],
      });
    },
  };
}

const DUAL_THEMES = {
  light: "one-light",
  dark: "one-dark-pro",
} as const;

/**
 * Highlight code in a single Shiki pass using dual-theme CSS variables so
 * light and dark themes share one tokenized HTML tree.
 */
export async function highlightCodeDualTheme(
  code: string,
  language: string,
  showLineNumbers = false,
  highlightedLines: number[] = []
): Promise<string> {
  const resolvedLanguage = resolveCodeLanguage(language);
  const transformers: ShikiTransformer[] =
    showLineNumbers || highlightedLines.length > 0
      ? [createLineTransformer(showLineNumbers, highlightedLines)]
      : [];
  const highlighter = await getHighlighter(resolvedLanguage);

  try {
    return highlighter.codeToHtml(code, {
      lang: resolvedLanguage,
      themes: DUAL_THEMES,
      defaultColor: "light",
      transformers,
    });
  } catch {
    return highlighter.codeToHtml(code, {
      lang: "text",
      themes: DUAL_THEMES,
      defaultColor: "light",
      transformers,
    });
  }
}

export async function highlightCode(
  code: string,
  language: string,
  showLineNumbers = false,
  highlightedLines: number[] = []
): Promise<[string, string]> {
  const dual = await highlightCodeDualTheme(
    code,
    language,
    showLineNumbers,
    highlightedLines
  );
  return [dual, dual];
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  highlightedLines = [],
  scrollToLine,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>("");
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;

    async function highlight() {
      const rendered = await highlightCodeDualTheme(
        code,
        language,
        showLineNumbers,
        highlightedLines
      );
      // Only apply if this is still the latest request AND not cancelled
      if (!cancelled && requestId === requestIdRef.current) {
        setHtml(rendered);
      }
    }

    void highlight();
    return () => {
      cancelled = true;
    };
  }, [code, highlightedLines, language, showLineNumbers]);

  useEffect(() => {
    if (!scrollToLine) return;

    const frame = requestAnimationFrame(() => {
      const target = containerRef.current?.querySelector<HTMLElement>(
        `[data-line-number="${scrollToLine}"]`
      );
      target?.scrollIntoView({ block: "center" });
    });

    return () => cancelAnimationFrame(frame);
  }, [html, scrollToLine]);

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
          className
        )}
        ref={containerRef}
        {...props}
      >
        <div className="relative">
          <div
            className="overflow-auto [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            // oxlint-disable-next-line react/no-danger -- syntax highlighting requires innerHTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
