import type {
  PublishArtifact,
  PublishVisibility,
} from "../../../publish/artifact";

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

/**
 * Local help metadata, checked against gno.sh src/lib/server/{billing,entitlements}.ts
 * on 2026-09-05. Keep in sync when hosted plan capabilities change. These labels
 * explain availability; only the hosted entitlement service authorizes publishing.
 */
export const PUBLISH_ACCESS_OPTIONS: ReadonlyArray<{
  value: PublishVisibility;
  label: string;
  audience: string;
  availability: string;
}> = [
  {
    value: "public",
    label: "Public",
    audience:
      "Anyone can read, discover, and download the published content, including search engines and agents.",
    availability: "Free and paid plans",
  },
  {
    value: "secret-link",
    label: "Secret link",
    audience:
      "Anyone with the link can read and forward it. Readers do not need an invitation.",
    availability: "Paid plans with private publishing",
  },
  {
    value: "invite-only",
    label: "Invite only",
    audience:
      "Personal shares start with owner access only. Choose recipients or the intended organization audience in Studio before publishing.",
    availability: "Paid plans with private publishing",
  },
  {
    value: "encrypted",
    label: "Encrypted",
    audience:
      "Anyone with both the link and passphrase can decrypt the content in their browser. Share the passphrase separately.",
    availability: "Paid plans with encrypted publishing",
  },
];

export function buildPublishExportRequest(input: {
  target: string;
  visibility: string | null;
  passphrase: string;
  passphraseConfirmation: string;
  audienceConfirmed: boolean;
}): {
  target: string;
  visibility: PublishVisibility;
  encryptionPassphrase?: string;
} {
  const option = PUBLISH_ACCESS_OPTIONS.find(
    ({ value }) => value === input.visibility
  );
  if (!option) {
    throw new Error("Choose who can read this export.");
  }
  if (!input.audienceConfirmed) {
    throw new Error("Review and confirm the audience before exporting.");
  }
  if (option.value === "encrypted") {
    if (!input.passphrase.trim()) {
      throw new Error("Enter a passphrase for the encrypted export.");
    }
    if (input.passphrase !== input.passphraseConfirmation) {
      throw new Error("The passphrases do not match.");
    }
    return {
      target: input.target,
      visibility: option.value,
      encryptionPassphrase: input.passphrase,
    };
  }
  return { target: input.target, visibility: option.value };
}
