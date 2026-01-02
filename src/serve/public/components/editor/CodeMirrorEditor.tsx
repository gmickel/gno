/**
 * CodeMirror 6 editor wrapper component.
 *
 * Provides markdown editing with syntax highlighting and dark theme.
 * Exposes imperative methods via ref: getValue, setValue, focus.
 */

import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, basicSetup } from "codemirror";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
} from "react";

export interface CodeMirrorEditorProps {
  /** Initial content to display */
  initialContent: string;
  /** Called when content changes */
  onChange: (content: string) => void;
  /** Additional CSS classes */
  className?: string;
}

export interface CodeMirrorEditorRef {
  /** Get current editor content */
  getValue: () => string;
  /** Set editor content programmatically */
  setValue: (content: string) => void;
  /** Focus the editor */
  focus: () => void;
}

function CodeMirrorEditorInner(
  { initialContent, onChange, className }: CodeMirrorEditorProps,
  ref: ForwardedRef<CodeMirrorEditorRef>
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  // Keep onChange ref current to avoid recreating editor on callback change
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Initialize CodeMirror
  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      doc: initialContent,
      extensions: [
        basicSetup,
        markdown(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        // Dark theme base styling
        EditorView.theme({
          "&": {
            height: "100%",
          },
          ".cm-scroller": {
            fontFamily: "ui-monospace, monospace",
            fontSize: "14px",
          },
        }),
      ],
      parent: containerRef.current,
    });

    viewRef.current = view;
    return () => view.destroy();
    // Only run on mount - initialContent should not trigger re-creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose imperative methods
  useImperativeHandle(ref, () => ({
    getValue: () => {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    setValue: (content: string) => {
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
        });
      }
    },
    focus: () => {
      viewRef.current?.focus();
    },
  }));

  return <div ref={containerRef} className={className} />;
}

export const CodeMirrorEditor = forwardRef(CodeMirrorEditorInner);
