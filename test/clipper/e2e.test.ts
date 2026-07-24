import { afterAll, describe, expect, test } from "bun:test";
// node:fs/promises is required for cleanup and filesystem assertions.
import { rm } from "node:fs/promises";
// node:path is required because Bun has no path utilities.
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";

import {
  assertFourHashes,
  input,
  latestJson,
  selectValue,
  waitForReceipt,
} from "./e2e-assertions";
import {
  activateFixtureSelection,
  createClipperE2EHarness,
  extensionIdFromWorker,
  grantExtensionLocalNetworkAccess,
  launchExtensionContext,
  recordClipperWire,
} from "./e2e-harness";
import { exerciseClipperRecovery } from "./e2e-recovery";

const enabled = process.env.GNO_CLIPPER_E2E === "1";
const HEX_64 = /^[a-f0-9]{64}$/u;
const EXACT_SELECTION = "Exact rendered selection — Zürich 日本語.";
const EXCLUDED_SECRETS = [
  "NAV_SECRET",
  "HIDDEN_ATTRIBUTE_SECRET",
  "INERT_SECRET",
  "ARIA_SECRET",
  "DISPLAY_NONE_SECRET",
  "OPACITY_SECRET",
  "ASIDE_SECRET",
  "FORM_SECRET",
  "IMAGE_SECRET",
  "SVG_SECRET",
  "MATHML_SECRET",
  "IFRAME_SECRET",
  "CANVAS_SECRET",
];

const buildExtension = async (): Promise<void> => {
  const packagedEntry = "browser-extension/build-cli.ts";
  const buildEntry = (await Bun.file(packagedEntry).exists())
    ? packagedEntry
    : "browser-extension/build.ts";
  const built = Bun.spawn([process.execPath, buildEntry], {
    cwd: process.cwd(),
    stderr: "inherit",
    stdout: "inherit",
  });
  expect(await built.exited).toBe(0);
};

if (!enabled) {
  test.skip("headed Chromium clipper E2E (set GNO_CLIPPER_E2E=1)", () => {});
} else {
  describe("installed Chromium browser clipper", () => {
    let context: BrowserContext | null = null;
    let cleanupRoot: string | null = null;
    let stopResident: (() => Promise<void>) | null = null;
    let stopFixture: (() => void) | null = null;

    afterAll(async () => {
      await context?.close();
      await stopResident?.();
      stopFixture?.();
      if (cleanupRoot) await rm(cleanupRoot, { force: true, recursive: true });
    });

    test(
      "pairs, extracts visible selection and Reader content, recovers, and revokes",
      async () => {
        await buildExtension();
        const harness = await createClipperE2EHarness();
        cleanupRoot = harness.root;
        stopResident = () => harness.stopResident();
        stopFixture = () => harness.fixture.stop();
        await harness.startResident();

        context = await launchExtensionContext(
          chromium,
          join(harness.root, "chromium-profile"),
          harness.extensionDir
        );
        recordClipperWire(context, harness.baseUrl, harness.records);
        const extensionId = await extensionIdFromWorker(context);
        expect(extensionId).toMatch(/^[a-p]{32}$/u);
        const extensionOrigin = `chrome-extension://${extensionId}`;

        const fixturePage = await context.newPage();
        await fixturePage.goto(`${harness.fixture.baseUrl}/fixture`, {
          waitUntil: "networkidle",
        });
        const backgroundPage = await context.newPage();
        await backgroundPage.setContent(
          "<main><p>BACKGROUND_TAB_SECRET</p></main>"
        );
        await activateFixtureSelection(fixturePage);

        let popup = await context.newPage();
        await grantExtensionLocalNetworkAccess(context);
        const popupConsole: string[] = [];
        popup.on("console", (message) => popupConsole.push(message.text()));
        context.on("request", (request) => {
          if (request.url().startsWith("http://127.0.0.1:")) {
            popupConsole.push(`request ${request.method()} ${request.url()}`);
          }
        });
        context.on("requestfailed", (request) => {
          if (request.url().startsWith("http://127.0.0.1:")) {
            popupConsole.push(
              `failed ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`
            );
          }
        });
        await popup.goto(`${extensionOrigin}/preview.html`);
        await popup.waitForFunction(async () => {
          const permission = await navigator.permissions.query({
            name: "local-network-access" as PermissionName,
          });
          return permission.state === "granted";
        });
        const gatewayInput = input(popup, "Local gateway");
        await gatewayInput.fill("");
        await gatewayInput.pressSequentially(harness.baseUrl);
        await gatewayInput.press("Tab");
        expect(await gatewayInput.inputValue()).toBe(harness.baseUrl);
        await popup.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              )
            )
        );
        const pairCodeOutput = popup.locator(".pair-code");
        const pairError = popup.locator(".error");
        await popup.getByRole("button", { name: "Pair with GNO" }).click();
        await Promise.race([
          pairCodeOutput.waitFor({ state: "visible" }),
          pairError.waitFor({ state: "visible" }).then(async () => {
            throw new Error(
              `${(await pairError.textContent()) ?? "Pairing failed without an error message"} wire=${JSON.stringify(harness.records)} console=${JSON.stringify(popupConsole)} input=${await gatewayInput.inputValue()}`
            );
          }),
        ]);
        if (!(await pairCodeOutput.isVisible())) {
          throw new Error(
            `${(await pairError.textContent()) ?? "Pairing failed without an error message"} wire=${JSON.stringify(harness.records)} console=${JSON.stringify(popupConsole)}`
          );
        }
        const pairingCode = await pairCodeOutput.textContent();
        expect(pairingCode).toMatch(/^\d{8}$/u);
        const approvalPage =
          context
            .pages()
            .find((page) => page.url().startsWith(harness.baseUrl)) ??
          (await context.waitForEvent("page", {
            predicate: (page) => page.url().startsWith(harness.baseUrl),
          }));

        await approvalPage.waitForURL(`${harness.baseUrl}/clipper/pair`);
        expect(new URL(approvalPage.url()).hash).toBe("");
        expect(new URL(approvalPage.url()).search).toBe("");
        await approvalPage.getByLabel("Pairing code").fill(pairingCode ?? "");
        await approvalPage
          .getByRole("button", { name: "Approve extension" })
          .click();
        await Promise.race([
          approvalPage.getByText("Browser paired").waitFor({
            state: "visible",
          }),
          approvalPage
            .locator('[role="alert"]')
            .waitFor({ state: "visible" })
            .then(async () => {
              throw new Error(
                `Approval failed: ${await approvalPage.locator('[role="alert"]').textContent()} wire=${JSON.stringify(harness.records)}`
              );
            }),
        ]);
        expect(await approvalPage.evaluate(() => localStorage.length)).toBe(0);
        expect(await approvalPage.evaluate(() => sessionStorage.length)).toBe(
          0
        );

        try {
          await popup
            .getByRole("heading", { name: "Capture visible context" })
            .waitFor({ state: "visible", timeout: 10_000 });
        } catch {
          throw new Error(
            `Extension did not consume the approved grant. wire=${JSON.stringify(harness.records)} console=${JSON.stringify(popupConsole)} body=${await popup.locator("body").innerText()}`
          );
        }
        const startResponse = await latestJson(
          harness.records,
          "/api/clipper/pair/start",
          "POST",
          200
        );
        const start = startResponse.body as Record<string, unknown>;
        expect(startResponse.headers.origin).toBe(extensionOrigin);
        expect(startResponse.headers.cookie).toBeUndefined();
        expect(startResponse.headers.authorization).toBeUndefined();
        const pairId = start.pairId as string;
        expect(pairId).toMatch(HEX_64);
        const approvalResponse = await latestJson(
          harness.records,
          "/api/clipper/pair/approve",
          "POST",
          200
        );
        expect(approvalResponse.headers.origin).toBe(harness.baseUrl);
        expect(approvalResponse.headers["x-gno-csrf"]).toMatch(HEX_64);
        expect(approvalResponse.headers.authorization).toBeUndefined();
        const serviceWorker = context.serviceWorkers()[0];
        expect(serviceWorker).toBeDefined();
        const consumed = await serviceWorker?.evaluate(
          async ({ url }) => {
            const response = await fetch(url, {
              method: "POST",
            });
            return { body: await response.json(), status: response.status };
          },
          { url: `${harness.baseUrl}/api/clipper/pair/${pairId}` }
        );
        expect(consumed).toEqual({
          body: { schemaVersion: "1.0", status: "consumed" },
          status: 410,
        });

        await activateFixtureSelection(fixturePage);
        await popup.getByRole("button", { name: "Extract now" }).click();
        await input(popup, "Collection").fill("notes");
        await input(popup, "Relative path (optional)").fill(
          "clips/selection.md"
        );
        await input(popup, "Tags").fill("browser, evidence");
        await popup
          .getByLabel("Page contains authenticated visible content")
          .check();
        await popup.getByRole("button", { name: "Server preview" }).click();
        await popup.locator(".preview").waitFor({ state: "visible" });

        const selectionPreviewResponse = await latestJson(
          harness.records,
          "/api/capture/clip/preview",
          "POST",
          200
        );
        const selectionPreview = selectionPreviewResponse.body as Record<
          string,
          unknown
        >;
        expect(selectionPreviewResponse.headers.origin).toBe(extensionOrigin);
        expect(selectionPreviewResponse.headers.authorization).toMatch(
          /^Bearer [a-f0-9]{64}$/u
        );
        expect(selectionPreviewResponse.headers.cookie).toBeUndefined();
        assertFourHashes(selectionPreview);
        const selectionProvenance = selectionPreview.provenance as Record<
          string,
          unknown
        >;
        expect(selectionProvenance.exactSelection).toBe(EXACT_SELECTION);
        expect(selectionProvenance.extractionWarnings).toEqual(
          expect.arrayContaining([
            "authenticated_visible_content",
            "canonical_url_differs",
            "reader_partial",
            "spa_snapshot",
          ])
        );
        expect(JSON.stringify(selectionPreview)).not.toContain(
          "BACKGROUND_TAB_SECRET"
        );

        await popup.getByRole("button", { name: "Confirm capture" }).click();
        await waitForReceipt(popup, "created");
        const createdReceiptResponse = await latestJson(
          harness.records,
          "/api/capture/clip",
          "POST",
          202
        );
        const createdReceipt = createdReceiptResponse.body as Record<
          string,
          unknown
        >;
        expect(createdReceiptResponse.headers.origin).toBe(extensionOrigin);
        expect(createdReceiptResponse.headers.authorization).toMatch(
          /^Bearer [a-f0-9]{64}$/u
        );
        const firstIdempotencyKey =
          createdReceiptResponse.headers["idempotency-key"];
        expect(firstIdempotencyKey).toBeTruthy();
        expect(createdReceipt.schemaVersion).toBe("1.0");
        expect(JSON.stringify(createdReceipt)).not.toContain("sourceHash");

        await popup.getByRole("button", { name: "Confirm capture" }).click();
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const writes = harness.records.filter(
            (record) =>
              new URL(record.url).pathname === "/api/capture/clip" &&
              record.method === "POST" &&
              record.status === 202
          );
          if (writes.length >= 2) break;
          await Bun.sleep(25);
        }
        const createdWrites = harness.records.filter(
          (record) =>
            new URL(record.url).pathname === "/api/capture/clip" &&
            record.method === "POST" &&
            record.status === 202
        );
        expect(createdWrites.length).toBeGreaterThanOrEqual(2);
        const replayedWrite = createdWrites.at(-1);
        expect(replayedWrite?.headers["idempotency-key"]).not.toBe(
          firstIdempotencyKey
        );
        expect(replayedWrite?.responseHeaders["idempotent-replay"]).toBe(
          "true"
        );
        expect(replayedWrite?.body).toMatchObject({
          collisionPolicyResult: "created",
        });

        const titleInput = input(popup, "Title");
        await titleInput.fill("Same evidence, updated page title");
        await titleInput.press("Tab");
        await popup.getByRole("button", { name: "Refresh preview" }).click();
        const openedPreviewResponse = await latestJson(
          harness.records,
          "/api/capture/clip/preview",
          "POST",
          200,
          2
        );
        const openedPreview = openedPreviewResponse.body as Record<
          string,
          unknown
        >;
        expect(
          (openedPreview.provenance as Record<string, unknown>).clipIdentity
        ).toBe(selectionProvenance.clipIdentity);
        expect(
          (openedPreview.provenance as Record<string, unknown>).previewDigest
        ).not.toBe(selectionProvenance.previewDigest);
        await popup.getByRole("button", { name: "Confirm capture" }).click();
        await waitForReceipt(popup, "opened_existing");
        expect(
          (await latestJson(harness.records, "/api/capture/clip", "POST", 200))
            .body
        ).toMatchObject({ collisionPolicyResult: "opened_existing" });

        const canonicalMarkdown = popup.getByLabel(
          "Canonical capture Markdown"
        );
        await canonicalMarkdown.fill("Edited final body with changed meaning.");
        await canonicalMarkdown.press("Tab");
        await popup.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              )
            )
        );
        expect(await canonicalMarkdown.inputValue()).toBe(
          "Edited final body with changed meaning."
        );
        await popup.getByRole("button", { name: "Refresh preview" }).click();
        const conflictPreviewResponse = await latestJson(
          harness.records,
          "/api/capture/clip/preview",
          "POST",
          200,
          3
        );
        const conflictPreview = conflictPreviewResponse.body as Record<
          string,
          unknown
        >;
        assertFourHashes(conflictPreview);
        expect(
          (conflictPreview.provenance as Record<string, unknown>).extractionHash
        ).toBe(selectionProvenance.extractionHash);
        expect(
          (conflictPreview.provenance as Record<string, unknown>).finalBodyHash
        ).not.toBe(selectionProvenance.finalBodyHash);
        expect((conflictPreview.plan as Record<string, unknown>).outcome).toBe(
          "conflict"
        );
        await popup.getByRole("button", { name: "Confirm capture" }).click();
        await waitForReceipt(popup, "conflict");
        expect(
          (await latestJson(harness.records, "/api/capture/clip", "POST", 409))
            .body
        ).toMatchObject({ collisionPolicyResult: "conflict" });

        await selectValue(popup, "create_with_suffix");
        await popup.getByRole("button", { name: "Refresh preview" }).click();
        await popup.getByRole("button", { name: "Confirm capture" }).click();
        await waitForReceipt(popup, "created_with_suffix");

        await activateFixtureSelection(fixturePage);
        await popup.getByRole("button", { name: "Reader" }).click();
        await popup.getByRole("button", { name: "Extract now" }).click();
        await input(popup, "Relative path (optional)").fill("clips/reader.md");
        await selectValue(popup, "error");
        await popup.getByRole("button", { name: "Server preview" }).click();
        const readerPreviewResponse = await latestJson(
          harness.records,
          "/api/capture/clip/preview",
          "POST",
          200,
          5
        );
        const readerPreview = readerPreviewResponse.body as Record<
          string,
          unknown
        >;
        assertFourHashes(readerPreview);
        const readerJson = JSON.stringify(readerPreview);
        const readerBody = (readerPreview.preview as Record<string, unknown>)
          .body as string;
        expect(readerJson).toContain("Visible article heading");
        expect(readerJson).toContain("Visible quoted evidence");
        expect(readerJson).toContain("const visible = true;");
        expect(readerBody).toContain("DANGEROUS\\_LINK\\_TEXT");
        expect(readerBody).not.toContain("javascript:");
        for (const secret of EXCLUDED_SECRETS) {
          expect(readerJson).not.toContain(secret);
        }
        expect(harness.fixture.canaryRequests).toEqual([]);

        popup = await exerciseClipperRecovery({
          context,
          extensionOrigin,
          harness,
          popup,
          records: harness.records,
        });
        expect(
          await Bun.file(
            join(harness.collectionDir, "clips", "reader.md")
          ).exists()
        ).toBe(true);

        const residentStatus = await approvalPage.evaluate(async () => {
          const response = await fetch("/api/resident/status");
          return response.json();
        });
        expect(JSON.stringify(residentStatus)).not.toMatch(
          /grantToken|csrfToken|pairingCode/u
        );

        await popup.getByRole("button", { name: "Revoke" }).click();
        await popup
          .getByRole("heading", { name: "Pair this browser" })
          .waitFor({ state: "visible" });
        const revokeResponse = await latestJson(
          harness.records,
          "/api/clipper/revoke",
          "POST",
          200
        );
        expect(revokeResponse.body).toMatchObject({ status: "revoked" });
        expect(revokeResponse.headers.origin).toBe(extensionOrigin);
        expect(revokeResponse.headers.authorization).toMatch(
          /^Bearer [a-f0-9]{64}$/u
        );

        const clipperRequests = harness.records.filter((record) =>
          new URL(record.url).pathname.startsWith("/api/clipper")
        );
        expect(clipperRequests.length).toBeGreaterThan(5);
        expect(harness.fixture.canaryRequests).toEqual([]);
      },
      { timeout: 180_000 }
    );
  });
}
