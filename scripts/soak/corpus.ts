/**
 * Seeded corpus for the soak harness. The harness owns every mutation, so it
 * also keeps the expected end state that convergence (I8) is checked against.
 *
 * Collections:
 * - `notes`: Markdown notes with wiki links; the churned, converged set.
 * - `office`: PDF/DOCX/PPTX fixtures plus a corrupt PDF (per-file failures).
 * - `cloudish`: `sourceAvailability: local` on a path GNO cannot verify, so
 *   every sync fails (the fn-202 shape).
 * - `edge`: pathological entries (unreadable, huge, binary, deep, unicode,
 *   symlink loop) that are excluded from the convergence comparison.
 *
 * @module scripts/soak/corpus
 */

/**
 * Collections built to fail on every sync. A watcher event in one keeps a
 * backoff retry pending (fn-202, checked by I7), so convergence does not wait
 * for their watcher work to drain.
 */
export const ALWAYS_FAILING_COLLECTIONS: ReadonlySet<string> = new Set([
  "cloudish",
]);

// node:fs/promises — directory structure, chmod, symlink and rename have no Bun equivalent
import { chmod, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
// node:path — Bun has no path utilities
import { dirname, join } from "node:path";

import type { Rng } from "./rng";

import { REPO_ROOT } from "./sandbox";

const WORDS =
  "alpha beta gamma delta index vector embedding battery sqlite resident scheduler lease page chunk model local document note meeting project decision review release watcher daemon search query capsule evidence archive session".split(
    " "
  );

const OFFICE_FIXTURES = [
  "pdf/sample.pdf",
  "pdf/standard-font.pdf",
  "docx/sample.docx",
  "pptx/sample.pptx",
  "pdf/corrupt.pdf",
];

export interface CorpusLayout {
  notes: string;
  office: string;
  cloudish: string;
  edge: string;
}

export class Corpus {
  readonly layout: CorpusLayout;
  /** notes rel path -> latest marker written into it. */
  readonly live = new Map<string, string>();
  private counter = 0;
  private readonly rng: Rng;

  constructor(root: string, rng: Rng) {
    this.layout = {
      notes: join(root, "notes"),
      office: join(root, "office"),
      cloudish: join(root, "cloudish"),
      edge: join(root, "edge"),
    };
    this.rng = rng;
  }

  private marker(): string {
    this.counter += 1;
    return `soakmarker${this.rng.seed.toString(36)}x${this.counter.toString(36)}`;
  }

  private body(marker: string): string {
    const paragraphs: string[] = [];
    const count = this.rng.int(2, 6);
    for (let p = 0; p < count; p += 1) {
      const words: string[] = [];
      for (let w = 0; w < this.rng.int(30, 90); w += 1)
        words.push(this.rng.pick(WORDS));
      paragraphs.push(words.join(" "));
    }
    const link =
      this.live.size > 0
        ? `[[${this.rng.pick([...this.live.keys()]).replace(/\.md$/, "")}]]`
        : "";
    return `${paragraphs.join("\n\n")}\n\n${link}\n\n${marker}\n`;
  }

  private notePath(rel: string): string {
    return join(this.layout.notes, rel);
  }

  async writeNote(rel: string): Promise<string> {
    const marker = this.marker();
    const path = this.notePath(rel);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `# ${rel}\n\n${this.body(marker)}`);
    this.live.set(rel, marker);
    return marker;
  }

  /** Editor-style atomic save: write a temp file, then rename over. */
  async atomicSave(rel: string): Promise<string> {
    const marker = this.marker();
    const path = this.notePath(rel);
    const temp = `${path}.tmp-${this.counter}`;
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(temp, `# ${rel}\n\n${this.body(marker)}`);
    await rename(temp, path);
    this.live.set(rel, marker);
    return marker;
  }

  async deleteNote(rel: string): Promise<void> {
    await rm(this.notePath(rel), { force: true });
    this.live.delete(rel);
  }

  async renameNote(from: string, to: string): Promise<void> {
    const marker = this.live.get(from);
    if (marker === undefined) return;
    await mkdir(dirname(this.notePath(to)), { recursive: true });
    await rename(this.notePath(from), this.notePath(to));
    this.live.delete(from);
    this.live.set(to, marker);
  }

  /** Move a whole directory; every note under it changes path. */
  async moveDir(from: string, to: string): Promise<void> {
    await mkdir(dirname(this.notePath(to)), { recursive: true });
    await rename(this.notePath(from), this.notePath(to));
    // Snapshot: entries are rewritten while iterating.
    for (const [rel, marker] of Array.from(this.live)) {
      if (rel.startsWith(`${from}/`)) {
        this.live.delete(rel);
        this.live.set(`${to}/${rel.slice(from.length + 1)}`, marker);
      }
    }
  }

  async deleteDir(dir: string): Promise<void> {
    await rm(this.notePath(dir), { recursive: true, force: true });
    for (const rel of Array.from(this.live.keys())) {
      if (rel.startsWith(`${dir}/`)) this.live.delete(rel);
    }
  }

  randomNote(): string | null {
    if (this.live.size === 0) return null;
    return this.rng.pick([...this.live.keys()]);
  }

  newNoteName(): string {
    this.counter += 1;
    return `d${this.rng.int(0, 29)}/new-${this.counter}.md`;
  }

  /** Build every collection. */
  async generate(docs: number): Promise<void> {
    for (const dir of Object.values(this.layout))
      await mkdir(dir, { recursive: true });
    for (let i = 0; i < docs; i += 1) {
      await this.writeNote(`d${i % 30}/note-${i}.md`);
    }
    for (const fixture of OFFICE_FIXTURES) {
      const source = join(REPO_ROOT, "test/fixtures/conversion", fixture);
      await Bun.write(
        join(this.layout.office, fixture.replace("/", "-")),
        Bun.file(source)
      );
    }
    for (let i = 0; i < 20; i += 1) {
      await Bun.write(
        join(this.layout.cloudish, `c${i}.md`),
        `# Cloud ${i}\n\n${this.body(this.marker())}`
      );
    }
    await this.generateEdge();
  }

  private async generateEdge(): Promise<void> {
    const edge = this.layout.edge;
    const unreadable = join(edge, "unreadable.md");
    await Bun.write(unreadable, "# unreadable\n");
    await chmod(unreadable, 0o000);
    await Bun.write(
      join(edge, "huge.md"),
      `# huge\n\n${"lorem ipsum dolor ".repeat(320_000)}\n`
    );
    const binary = new Uint8Array(64 * 1024);
    for (let i = 0; i < binary.length; i += 1) binary[i] = this.rng.int(0, 255);
    await Bun.write(join(edge, "binary.md"), binary);
    let deep = edge;
    for (let depth = 0; depth < 40; depth += 1)
      deep = join(deep, `level${depth}`);
    await mkdir(deep, { recursive: true });
    await Bun.write(join(deep, "deep.md"), "# deep\n\ndeep note\n");
    await Bun.write(
      join(edge, "ünïcödé 名前 🗂.md"),
      "# unicode\n\nunicode name\n"
    );
    await Bun.write(
      join(edge, `${"long".repeat(50)}.md`),
      "# long\n\nlong name\n"
    );
    await mkdir(join(edge, "loop"), { recursive: true });
    await symlink("..", join(edge, "loop", "parent")).catch(() => undefined);
    await mkdir(join(edge, "empty-dir"), { recursive: true });
  }

  /** Restore permissions so the sandbox can be deleted. */
  async unlockEdge(): Promise<void> {
    await chmod(join(this.layout.edge, "unreadable.md"), 0o644).catch(
      () => undefined
    );
  }

  /** Eligible Markdown files actually on disk under notes (ground truth). */
  async walkNotes(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
      }
    };
    await walk(this.layout.notes, "");
    return out.sort();
  }
}

export interface ConfigOptions {
  modelBlock: Record<string, unknown>;
  /** Collection-level overrides, e.g. an updateCmd for one torture class. */
  extraCollections?: Record<string, unknown>[];
  include?: { office?: boolean; cloudish?: boolean; edge?: boolean };
}

export function buildConfig(
  layout: CorpusLayout,
  options: ConfigOptions
): Record<string, unknown> {
  const include = {
    office: true,
    cloudish: true,
    edge: true,
    ...options.include,
  };
  const collection = (
    name: string,
    path: string,
    extra: Record<string, unknown> = {}
  ) => ({
    name,
    path,
    pattern: "**/*",
    include: [],
    exclude: [".git", "node_modules"],
    ...extra,
  });
  const collections = [collection("notes", layout.notes)];
  if (include.office) collections.push(collection("office", layout.office));
  if (include.cloudish)
    collections.push(
      collection("cloudish", layout.cloudish, { sourceAvailability: "local" })
    );
  if (include.edge) collections.push(collection("edge", layout.edge));
  collections.push(
    ...((options.extraCollections ?? []) as ReturnType<typeof collection>[])
  );
  return {
    version: "1.0",
    ftsTokenizer: "snowball english",
    busyTimeoutMs: 60_000,
    collections,
    contexts: [],
    contentTypes: [],
    models: options.modelBlock,
  };
}

export async function writeConfig(
  configDir: string,
  config: Record<string, unknown>
): Promise<string> {
  const path = join(configDir, "index.yml");
  // JSON is valid YAML; the loader accepts it as-is.
  await Bun.write(path, JSON.stringify(config, null, 2));
  return path;
}
