import { packageClipper } from "./package";

const result = await packageClipper();
console.log(
  `Browser clipper package: ${result.archivePath}\nSHA-256: ${result.checksum}`
);
