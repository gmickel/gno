import { expect, spyOn, test } from "bun:test";
// Bun lacks synchronous descriptor metadata, rename, and private-file creation APIs.
import * as fs from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no OS temporary-directory API.
import { join } from "node:path"; // Bun has no path helpers.

import { readChildBootstrap } from "../../../evals/acceptance/native-child-preload";
import { privateCapturePath } from "../../../evals/acceptance/windows-observation";

test("bootstrap reads a private regular file and rejects a symbolic link", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-bootstrap-handle-"))
  );
  try {
    privateCapturePath(root, true);
    const path = join(root, "bootstrap.json");
    fs.writeFileSync(path, '{"original":true}', { mode: 0o600 });
    expect(readChildBootstrap(path)).toBe('{"original":true}');
    const link = join(root, "link.json");
    await symlink(path, link);
    expect(() => readChildBootstrap(link)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("bootstrap rejects pathname replacement and closes its original read handle", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-bootstrap-race-"))
  );
  const originalRead = fs.readFileSync;
  let descriptor: number | undefined;
  let restore = () => {};
  try {
    privateCapturePath(root, true);
    const path = join(root, "bootstrap.json");
    fs.writeFileSync(path, '{"original":true}', { mode: 0o600 });
    const replacement = join(root, "replacement.json");
    fs.writeFileSync(replacement, '{"replaced":true}', { mode: 0o600 });
    const read = spyOn(fs, "readFileSync").mockImplementation(((
      input,
      options
    ) => {
      expect(typeof input).toBe("number");
      descriptor = input as number;
      fs.renameSync(path, join(root, "original.json"));
      fs.renameSync(replacement, path);
      return originalRead(input, options);
    }) as typeof fs.readFileSync);
    restore = () => read.mockRestore();
    expect(() => readChildBootstrap(path)).toThrow("replaced during read");
    expect(descriptor).toBeDefined();
    expect(() => fs.fstatSync(descriptor!)).toThrow();
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
