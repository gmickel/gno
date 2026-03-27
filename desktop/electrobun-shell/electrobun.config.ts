// node:path has no Bun equivalent.
import { resolve } from "node:path";

import pkg from "../../package.json";

interface ShellElectrobunConfig {
  app: {
    name: string;
    identifier: string;
    version: string;
    urlSchemes?: string[];
  };
  runtime?: Record<string, unknown>;
  build?: Record<string, unknown>;
}

const repoRoot = resolve(import.meta.dir, "../..");

export default {
  app: {
    name: "GNO Desktop Beta",
    identifier: "tech.mickel.gno.beta",
    version: pkg.version,
    urlSchemes: ["gno"],
  },
  runtime: {
    gnoRepoRoot: repoRoot,
    gnoServePort: 3927,
    gnoControlPort: 3928,
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
} satisfies ShellElectrobunConfig;
