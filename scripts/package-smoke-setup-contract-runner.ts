/** Fail-closed child entry point for installed setup contract proof. */

import {
  assertInstalledSetupIsolation,
  assertPackageSmokePathContained,
} from "./package-smoke-isolation";
import {
  type InstalledSetupContractOptions,
  verifyInstalledSetupContracts,
} from "./package-smoke-setup-contract";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Installed setup contract child requires an input path");
}

try {
  const options = (await Bun.file(
    inputPath
  ).json()) as InstalledSetupContractOptions;
  await assertInstalledSetupIsolation(options, inputPath);
  await assertPackageSmokePathContained(
    options.tempRoot,
    options.lexicalReceipt.input.folder,
    "setup receipt folder"
  );
  await assertPackageSmokePathContained(
    options.tempRoot,
    options.lexicalReceipt.paths.config,
    "setup receipt config"
  );
  await assertPackageSmokePathContained(
    options.tempRoot,
    options.lexicalReceipt.paths.receipt,
    "setup receipt path"
  );
  await verifyInstalledSetupContracts(options);
  process.exit(0);
} catch (error) {
  const message =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
