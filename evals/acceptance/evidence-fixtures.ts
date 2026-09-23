import { canonicalFingerprint, sha256Bytes } from "../agentic/canonical";
import pins from "../fixtures/acceptance/evidence-coverage/manifest.json";
import { validateEvidenceFixtures } from "./evidence";

export async function loadEvidenceFixtures() {
  const text = await Bun.file(
    new URL(
      "../fixtures/acceptance/evidence-coverage/fixtures.json",
      import.meta.url
    )
  ).text();
  if (sha256Bytes(text) !== pins.fixturesSha256)
    throw new Error(
      "Evidence fixture drift: create a new version, never repin a failed baseline"
    );
  const fixtures = validateEvidenceFixtures(JSON.parse(text));
  return { fixtures, sha256: canonicalFingerprint(fixtures) };
}
