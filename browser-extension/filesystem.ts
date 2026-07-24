// node:fs/promises supplies atomic directory renames and structure operations.
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const replaceDirectory = async (
  temporary: string,
  target: string
): Promise<void> => {
  const backup = join(
    dirname(target),
    `.${basename(target)}-backup-${process.pid}`
  );
  await rm(backup, { force: true, recursive: true });
  let hadTarget = false;
  try {
    await rename(target, backup);
    hadTarget = true;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  try {
    await rename(temporary, target);
  } catch (error) {
    if (hadTarget) {
      await rename(backup, target);
    }
    throw error;
  }

  try {
    await rm(backup, { force: true, recursive: true });
  } catch (error) {
    throw new Error(
      `Browser clipper replacement succeeded but backup cleanup failed: ${backup}`,
      { cause: error }
    );
  }
};
