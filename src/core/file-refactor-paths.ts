/** Browser-safe path target planning for canonical rename and move. */

// node:path/posix — no Bun path utils
import { posix as pathPosix } from "node:path";

import { validateRelPath } from "./validation";

export interface RenamePlan {
  nextRelPath: string;
  nextUri: string;
}

export interface MovePlan {
  nextRelPath: string;
  nextUri: string;
}

export function planRenameRefactor(input: {
  collection: string;
  currentRelPath: string;
  nextName: string;
}): RenamePlan {
  const current = validateRelPath(input.currentRelPath);
  const directory = pathPosix.dirname(current);
  const currentExt = pathPosix.extname(current);
  const nextFilename = pathPosix.extname(input.nextName)
    ? input.nextName
    : `${input.nextName}${currentExt}`;
  const nextRelPath =
    directory === "."
      ? validateRelPath(nextFilename)
      : validateRelPath(`${directory}/${nextFilename}`);

  return {
    nextRelPath,
    nextUri: `gno://${input.collection}/${nextRelPath}`,
  };
}

export function planMoveRefactor(input: {
  collection: string;
  currentRelPath: string;
  folderPath: string;
  nextName?: string;
}): MovePlan {
  const current = validateRelPath(input.currentRelPath);
  const safeFolder = validateRelPath(input.folderPath).replace(
    /^\.\/|\/+$/g,
    ""
  );
  const filename = input.nextName?.trim() || pathPosix.basename(current);
  const nextRelPath = safeFolder
    ? validateRelPath(`${safeFolder}/${filename}`)
    : validateRelPath(filename);

  return {
    nextRelPath,
    nextUri: `gno://${input.collection}/${nextRelPath}`,
  };
}
