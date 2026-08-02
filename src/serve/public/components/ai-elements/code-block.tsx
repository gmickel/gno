import type { ShikiTransformer } from "shiki/types";

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
import { type BundledLanguage, createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

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

const highlighterPromise = createHighlighter({
  engine: createJavaScriptRegexEngine(),
  langs: ["text"],
  themes: ["one-light", "one-dark-pro"],
});

async function getHighlighter(language: BundledLanguage | "text") {
  const highlighter = await highlighterPromise;
  if (!highlighter.getLoadedLanguages().includes(language)) {
    await highlighter.loadLanguage(language);
  }
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

export async function highlightCode(
  code: string,
  language: string,
  showLineNumbers = false,
  highlightedLines: number[] = []
): Promise<[string, string]> {
  const resolvedLanguage = resolveCodeLanguage(language);
  const transformers: ShikiTransformer[] =
    showLineNumbers || highlightedLines.length > 0
      ? [createLineTransformer(showLineNumbers, highlightedLines)]
      : [];
  const highlighter = await getHighlighter(resolvedLanguage);

  try {
    return [
      highlighter.codeToHtml(code, {
        lang: resolvedLanguage,
        theme: "one-light",
        transformers,
      }),
      highlighter.codeToHtml(code, {
        lang: resolvedLanguage,
        theme: "one-dark-pro",
        transformers,
      }),
    ];
  } catch {
    return [
      highlighter.codeToHtml(code, {
        lang: "text",
        theme: "one-light",
        transformers,
      }),
      highlighter.codeToHtml(code, {
        lang: "text",
        theme: "one-dark-pro",
        transformers,
      }),
    ];
  }
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
  const [darkHtml, setDarkHtml] = useState<string>("");
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;

    async function highlight() {
      const [light, dark] = await highlightCode(
        code,
        language,
        showLineNumbers,
        highlightedLines
      );
      // Only apply if this is still the latest request AND not cancelled
      if (!cancelled && requestId === requestIdRef.current) {
        setHtml(light);
        setDarkHtml(dark);
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
  }, [darkHtml, html, scrollToLine]);

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
            className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            // oxlint-disable-next-line react/no-danger -- syntax highlighting requires innerHTML
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div
            className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-4 [&>pre]:text-foreground! [&>pre]:text-sm [&_code]:font-mono [&_code]:text-sm"
            // oxlint-disable-next-line react/no-danger -- syntax highlighting requires innerHTML
            dangerouslySetInnerHTML={{ __html: darkHtml }}
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
