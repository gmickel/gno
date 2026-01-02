/**
 * MarkdownPreview - Renders markdown with syntax highlighting.
 *
 * Uses react-markdown with shiki syntax highlighting via CodeBlock.
 * Matches the "Scholarly Dusk" design system.
 */

import type { ComponentProps, FC, ReactNode } from "react";
import type { BundledLanguage } from "shiki";

import { ExternalLinkIcon } from "lucide-react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { cn } from "../../lib/utils";
import { CodeBlock, CodeBlockCopyButton } from "../ai-elements/code-block";

export interface MarkdownPreviewProps {
  /** Markdown content to render */
  content: string;
  /** Additional CSS classes */
  className?: string;
}

// Inline code styling
// Note: Destructure `node` to prevent react-markdown from leaking it to DOM
const InlineCode: FC<ComponentProps<"code"> & { node?: unknown }> = ({
  className,
  children,
  node: _node,
  ...props
}) => (
  <code
    className={cn(
      "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-primary",
      className
    )}
    {...props}
  >
    {children}
  </code>
);

// Link handling - external links open in new tab
const Link: FC<ComponentProps<"a"> & { node?: unknown }> = ({
  href,
  children,
  className,
  node: _node,
  ...props
}) => {
  const isExternal = href?.startsWith("http");
  return (
    <a
      className={cn(
        "text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary",
        "inline-flex items-center gap-0.5",
        className
      )}
      href={href}
      rel={isExternal ? "noopener noreferrer" : undefined}
      target={isExternal ? "_blank" : undefined}
      {...props}
    >
      {children}
      {isExternal && <ExternalLinkIcon className="inline size-3 opacity-60" />}
    </a>
  );
};

// Heading styles with proper hierarchy
const createHeading =
  (level: 1 | 2 | 3 | 4 | 5 | 6): FC<{ children?: ReactNode }> =>
  ({ children }) => {
    const Tag = `h${level}` as const;
    const sizes = {
      1: "text-3xl mt-8 mb-4 pb-2 border-b border-border/50",
      2: "text-2xl mt-6 mb-3 pb-1.5 border-b border-border/30",
      3: "text-xl mt-5 mb-2",
      4: "text-lg mt-4 mb-2",
      5: "text-base mt-3 mb-1 font-semibold",
      6: "text-sm mt-3 mb-1 font-semibold text-muted-foreground",
    };
    return (
      <Tag className={cn("font-serif tracking-tight", sizes[level])}>
        {children}
      </Tag>
    );
  };

// Code block with syntax highlighting
const Pre: FC<ComponentProps<"pre">> = ({ children, ...props }) => {
  // Extract code element from children
  const codeElement = children as React.ReactElement<{
    className?: string;
    children?: string;
  }>;

  if (!codeElement?.props) {
    return <pre {...props}>{children}</pre>;
  }

  const className = codeElement.props.className ?? "";
  const code = String(codeElement.props.children ?? "").trim();

  // Extract language from className (e.g., "language-typescript")
  const match = /language-(\w+)/.exec(className);
  const language = (match?.[1] ?? "plaintext") as BundledLanguage;

  return (
    <div className="group/code my-4">
      <CodeBlock
        className="rounded-lg border border-border/60 bg-muted/30"
        code={code}
        language={language}
      >
        <CodeBlockCopyButton
          className="opacity-0 transition-opacity group-hover/code:opacity-100"
          size="icon-sm"
          variant="ghost"
        />
      </CodeBlock>
    </div>
  );
};

// Blockquote with refined scholarly styling
const Blockquote: FC<ComponentProps<"blockquote"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <blockquote
    className={cn(
      "my-5 border-l-[3px] border-primary/40 bg-muted/20 py-3 pr-5 pl-5",
      "font-serif text-[0.95em] italic text-muted-foreground/90",
      "rounded-r-md shadow-sm",
      "[&>p]:mb-0",
      className
    )}
    {...props}
  >
    {children}
  </blockquote>
);

// List styles
const UnorderedList: FC<ComponentProps<"ul"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <ul
    className={cn("my-3 ml-6 list-disc space-y-1 [&>li]:pl-1", className)}
    {...props}
  >
    {children}
  </ul>
);

const OrderedList: FC<ComponentProps<"ol"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <ol
    className={cn("my-3 ml-6 list-decimal space-y-1 [&>li]:pl-1", className)}
    {...props}
  >
    {children}
  </ol>
);

// Table styles - refined scholarly aesthetic
// Note: Destructure `node` to prevent react-markdown from leaking it to DOM
const Table: FC<ComponentProps<"table"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <div className="my-4 overflow-x-auto rounded-lg border border-border/60 shadow-sm">
    <table
      className={cn("w-full border-collapse text-sm", className)}
      {...props}
    >
      {children}
    </table>
  </div>
);

const TableHead: FC<ComponentProps<"thead"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <thead
    className={cn(
      "bg-muted/60 border-b border-border/50",
      "text-muted-foreground uppercase tracking-wider text-xs",
      className
    )}
    {...props}
  >
    {children}
  </thead>
);

const TableRow: FC<ComponentProps<"tr"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <tr
    className={cn(
      "border-b border-border/30 last:border-0",
      "transition-colors hover:bg-white/5",
      "odd:bg-white/[0.03]",
      className
    )}
    {...props}
  >
    {children}
  </tr>
);

const TableCell: FC<ComponentProps<"td"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <td className={cn("px-4 py-2.5 align-top", className)} {...props}>
    {children}
  </td>
);

const TableHeaderCell: FC<ComponentProps<"th"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <th
    className={cn("px-4 py-2.5 text-left font-semibold", className)}
    {...props}
  >
    {children}
  </th>
);

// Horizontal rule
const Hr: FC = () => <hr className="my-6 border-0 border-t border-border/50" />;

// Paragraph
const Paragraph: FC<ComponentProps<"p"> & { node?: unknown }> = ({
  children,
  className,
  node: _node,
  ...props
}) => (
  <p className={cn("mb-4 leading-relaxed last:mb-0", className)} {...props}>
    {children}
  </p>
);

// Image with proper styling
const Image: FC<ComponentProps<"img"> & { node?: unknown }> = ({
  alt,
  className,
  node: _node,
  ...props
}) => (
  <img
    alt={alt ?? ""}
    className={cn(
      "my-4 max-w-full rounded-lg border border-border/40",
      className
    )}
    {...props}
  />
);

// Component mapping for react-markdown
const components = {
  h1: createHeading(1),
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
  p: Paragraph,
  a: Link,
  code: InlineCode,
  pre: Pre,
  blockquote: Blockquote,
  ul: UnorderedList,
  ol: OrderedList,
  table: Table,
  thead: TableHead,
  tr: TableRow,
  td: TableCell,
  th: TableHeaderCell,
  hr: Hr,
  img: Image,
};

/**
 * Renders markdown content with syntax highlighting and proper styling.
 * Sanitizes HTML to prevent XSS attacks.
 */
export const MarkdownPreview = memo(
  ({ content, className }: MarkdownPreviewProps) => {
    if (!content) {
      return (
        <div className={cn("text-muted-foreground italic", className)}>
          No content to display
        </div>
      );
    }

    return (
      <div
        className={cn(
          "prose prose-invert max-w-none",
          "text-foreground/90",
          "[&>*:first-child]:mt-0",
          className
        )}
      >
        <ReactMarkdown
          components={components}
          rehypePlugins={[rehypeSanitize]}
          remarkPlugins={[remarkGfm]}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
);

MarkdownPreview.displayName = "MarkdownPreview";
