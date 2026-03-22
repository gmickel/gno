import { apiFetch } from "../hooks/use-api";

interface DocAvailabilityResponse {
  uri: string;
}

export async function waitForDocumentAvailability(
  uri: string,
  attempts = 20,
  delayMs = 250
): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const { data } = await apiFetch<DocAvailabilityResponse>(
      `/api/doc?uri=${encodeURIComponent(uri)}`
    );
    if (data?.uri === uri) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}
