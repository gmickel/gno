/** Model a non-source filesystem entry without relying on MSYS mkfifo emulation. */
import { spyOn } from "bun:test";
// node:fs — no Bun equivalent for no-follow metadata and Stats prototypes.
import { lstatSync } from "node:fs";

export function mockSpecialWatcherFile(path: string): () => void {
  const target = lstatSync(path, { bigint: true });
  const prototypes = new Set([
    Object.getPrototypeOf(lstatSync(path)),
    Object.getPrototypeOf(target),
  ]);
  const spies = [...prototypes].map((prototype) => {
    const original: () => boolean = prototype.isFile;
    return spyOn(prototype, "isFile").mockImplementation(
      function (this: { ino: number | bigint; dev: number | bigint }): boolean {
        if (
          this.ino ===
            (typeof this.ino === "bigint" ? target.ino : Number(target.ino)) &&
          this.dev ===
            (typeof this.dev === "bigint" ? target.dev : Number(target.dev))
        )
          return false;
        return original.call(this);
      }
    );
  });
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}
