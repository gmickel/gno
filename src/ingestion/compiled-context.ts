/** Generated context is derived evidence and must not feed recursive retrieval. */
const SIDECAR_MARKER = /"artifactKind"\s*:\s*"gno_compiled_context_sidecar"/;
export function isCompiledContextPath(path: string): boolean {
  return path
    .toLowerCase()
    .split(/[\\/]/)
    .some((part) => part.includes(".gno-context."));
}
export function isCompiledContextContent(prefix: Uint8Array): boolean {
  const text = new TextDecoder().decode(prefix).trimStart();
  return (
    text.startsWith("<!-- gno:compiled-context ") ||
    (text.startsWith("{") && SIDECAR_MARKER.test(text))
  );
}
