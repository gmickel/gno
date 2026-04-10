import type { PublishArtifact } from "../../../publish/artifact";

export interface PublishExportResponse {
  artifact: PublishArtifact;
  fileName: string;
  uploadUrl: string;
}

export function downloadPublishArtifactFile(
  input: PublishExportResponse
): void {
  const blob = new Blob([JSON.stringify(input.artifact, null, 2)], {
    type: "application/json",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = input.fileName;
  anchor.click();
  URL.revokeObjectURL(href);
}
