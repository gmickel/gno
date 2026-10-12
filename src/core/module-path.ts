/**
 * A module's own file path and directory, from the caller's `import.meta`.
 *
 * Bun sets `import.meta.path` and `import.meta.dir` (inside a compiled
 * executable they are `/$bunfs/...` or `B:/~BUN/...` paths). Other module
 * runners, such as the vitest runner the evals use, leave them undefined but
 * always set `import.meta.url`. Callers pass their own `import.meta`: this
 * module's would name this file.
 *
 * @module src/core/module-path
 */

// node:path — no Bun path utils.
import { dirname } from "node:path";
// node:url — no Bun equivalent for file:// URL to path conversion.
import { fileURLToPath } from "node:url";

/** The `import.meta` fields read here; the Bun-only ones may be absent. */
export interface ModuleMeta {
  readonly url: string;
  readonly path?: string;
  readonly dir?: string;
}

/** Absolute path of the module that owns `meta`. */
export function modulePath(meta: ModuleMeta): string {
  return meta.path ?? fileURLToPath(meta.url);
}

/** Absolute directory of the module that owns `meta`. */
export function moduleDir(meta: ModuleMeta): string {
  return meta.dir ?? dirname(modulePath(meta));
}
