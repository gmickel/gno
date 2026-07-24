import type { Page } from "playwright";

import { expect } from "bun:test";

import type { RecordedResponse } from "./e2e-harness";

const HEX_64 = /^[a-f0-9]{64}$/u;

export const input = (popup: Page, label: string) =>
  popup.getByLabel(label, { exact: true });

export const selectValue = async (
  popup: Page,
  value: string
): Promise<void> => {
  const select = popup.locator("select");
  expect(await select.count()).toBe(1);
  await select.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Expected a select element");
    }
    element.value = nextValue;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  expect(await select.inputValue()).toBe(value);
};

export const waitForReceipt = async (
  popup: Page,
  outcome: string
): Promise<void> => {
  await popup
    .locator(".receipt")
    .getByText(outcome, { exact: true })
    .waitFor({ state: "visible", timeout: 20_000 });
};

export const latestJson = async (
  records: RecordedResponse[],
  pathname: string,
  method: string,
  status: number,
  minimumCount = 1
): Promise<RecordedResponse> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matches = records.filter(
      (record) =>
        new URL(record.url).pathname === pathname &&
        record.method === method &&
        record.status === status
    );
    const match = matches.at(-1);
    if (match && matches.length >= minimumCount) return match;
    await Bun.sleep(25);
  }
  throw new Error(`Missing ${method} ${pathname} response with HTTP ${status}`);
};

export const assertFourHashes = (preview: Record<string, unknown>): void => {
  const provenance = preview.provenance as Record<string, unknown>;
  expect(provenance.extractionHash).toMatch(HEX_64);
  expect(provenance.finalBodyHash).toMatch(HEX_64);
  expect(provenance.clipIdentity).toMatch(HEX_64);
  expect(provenance.previewDigest).toMatch(HEX_64);
  expect((preview.preview as Record<string, unknown>).digest).toBe(
    provenance.previewDigest
  );
  expect(JSON.stringify(preview)).not.toContain("sourceHash");
};
