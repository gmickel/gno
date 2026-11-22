/**
 * DocView-only re-export of MarkdownPreview.
 *
 * Bypasses the `components/editor` barrel so read-only DocView does not pull
 * CodeMirror into its chunk, and keeps a separate module path so DocView DOM
 * tests can mock.module it without sticky-mocking the real MarkdownPreview suite.
 */
export {
  MarkdownPreview,
  type MarkdownPreviewProps,
} from "../components/editor/MarkdownPreview";
