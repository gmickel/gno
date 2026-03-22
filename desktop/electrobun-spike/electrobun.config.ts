import type { ElectrobunConfig } from "electrobun";

// node:path has no Bun equivalent.
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

export default {
  app: {
    name: "GNO Electrobun Spike",
    identifier: "tech.mickel.gno.spike",
    version: "0.0.0",
    urlSchemes: ["gno"],
  },
  runtime: {
    gnoRepoRoot: repoRoot,
    gnoServePort: 3927,
  },
  build: {
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
