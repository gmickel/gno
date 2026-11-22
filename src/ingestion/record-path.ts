const RECORD_VIRTUAL_ROOT = ".gno/records";

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** Precomputed virtual path prefix for one container source path. */
export const recordVirtualPathPrefix = (sourcePath: string): string =>
  `${RECORD_VIRTUAL_ROOT}/${sha256(sourcePath).slice(0, 16)}/`;

/** Stable internal path for one logical record inside an export container. */
export const recordVirtualPath = (
  sourcePath: string,
  recordKey: string
): string => `${recordVirtualPathPrefix(sourcePath)}${recordKey}.md`;

/** Physical files may never occupy GNO's virtual-record namespace. */
export const isRecordVirtualPath = (relativePath: string): boolean => {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized === RECORD_VIRTUAL_ROOT ||
    normalized.startsWith(`${RECORD_VIRTUAL_ROOT}/`)
  );
};
