/** Bounded, UTF-8-only reads for the tracked project profile source. */

export const PROJECT_PROFILE_FILE_MAX_BYTES = 1_048_576;

export class ProjectProfileFileError extends Error {
  readonly code: "PROFILE_FILE_INVALID" | "PROFILE_FILE_TOO_LARGE";

  constructor(
    code: "PROFILE_FILE_INVALID" | "PROFILE_FILE_TOO_LARGE",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

export async function readProjectProfileFile(path: string): Promise<string> {
  const bytes = new Uint8Array(
    await Bun.file(path)
      .slice(0, PROJECT_PROFILE_FILE_MAX_BYTES + 1)
      .arrayBuffer()
  );
  if (bytes.byteLength > PROJECT_PROFILE_FILE_MAX_BYTES) {
    throw new ProjectProfileFileError(
      "PROFILE_FILE_TOO_LARGE",
      `Project profile exceeds ${PROJECT_PROFILE_FILE_MAX_BYTES} bytes.`
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectProfileFileError(
      "PROFILE_FILE_INVALID",
      "Project profile is not valid UTF-8."
    );
  }
}
