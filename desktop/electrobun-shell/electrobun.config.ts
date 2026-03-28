// node:path has no Bun equivalent.
import { resolve } from "node:path";

import pkg from "../../package.json";
import { DEFAULT_GNO_RUNTIME_FOLDER } from "./src/shared/runtime-layout";

interface ShellElectrobunConfig {
  app: {
    name: string;
    identifier: string;
    version: string;
    urlSchemes?: string[];
  };
  runtime?: Record<string, unknown>;
  build?: Record<string, unknown>;
  scripts?: Record<string, string>;
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
    gnoRuntimeFolder: DEFAULT_GNO_RUNTIME_FOLDER,
    gnoServePort: 3927,
    gnoControlPort: 3928,
  },
  build: {
    copy: {
      ".generated/gno-runtime": DEFAULT_GNO_RUNTIME_FOLDER,
    },
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
  scripts: {
    preBuild: "./scripts/stage-gno-runtime.ts",
    postPackage: "",
  },
} satisfies ShellElectrobunConfig;
