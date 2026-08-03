/**
 * URL/copy behavior for readable section links vs citation selectors.
 */

import { describe, expect, test } from "bun:test";

import {
  createSectionTarget,
  SECTION_TARGET_LINK_PARAM,
} from "../../../../src/core/sections";
import {
  buildCitationSectionUrl,
  buildReadableSectionUrl,
  createCitationSectionUrl,
  readSectionTargetLinkParam,
  resolveSectionLinkNavigation,
  SECTION_LINK_NOTICE_COPY,
  stripSectionTargetLinkParam,
} from "../../../../src/serve/public/lib/section-links";
import {
  SECTION_AMBIGUOUS_CONTENT,
  SECTION_FIXTURE_CONTENT,
  SECTION_FIXTURE_URI,
  SECTION_MISSING_CONTENT,
  SECTION_RECOVERED_CONTENT,
  SECTION_STALE_CONTENT,
  captureFixtureTarget,
} from "../../../helpers/section-target-fixtures";

const ORIGIN = "http://127.0.0.1:3000";

describe("section link helpers", () => {
  test("readable copy-link stays human and omits durable selector", () => {
    const url = buildReadableSectionUrl(ORIGIN, {
      uri: SECTION_FIXTURE_URI,
      view: "rendered",
      anchor: "setup",
    });
    expect(url).toBe(
      `${ORIGIN}/doc?uri=gno%3A%2F%2Fwork%2Fnotes%2Fpilot.md&view=rendered#setup`
    );
    expect(url.includes(`${SECTION_TARGET_LINK_PARAM}=`)).toBe(false);
    expect(url).not.toContain("Install Bun");
  });

  test("citation link is additive versioned and size-bounded", async () => {
    const target = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const url = buildCitationSectionUrl(
      ORIGIN,
      {
        uri: SECTION_FIXTURE_URI,
        view: "rendered",
        anchor: "setup",
      },
      target
    );
    expect(url).not.toBeNull();
    expect(url!).toContain(`#setup`);
    expect(url!).toContain(`${SECTION_TARGET_LINK_PARAM}=1.`);
    expect(url!.length).toBeLessThan(4000);

    const param = readSectionTargetLinkParam(
      `?${url!.split("?")[1]?.split("#")[0] ?? ""}`
    );
    expect(param?.startsWith("1.")).toBe(true);
  });

  test("old readable links still navigate without citation evidence", async () => {
    const result = await resolveSectionLinkNavigation({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: null,
      hashAnchor: "setup",
    });
    expect(result.blockHashNavigation).toBe(false);
    expect(result.navigateAnchor).toBe("setup");
    expect(result.notice).toBeNull();
  });

  test("exact and recovered citation links navigate to current anchor", async () => {
    const created = await createCitationSectionUrl({
      origin: ORIGIN,
      uri: SECTION_FIXTURE_URI,
      content: SECTION_FIXTURE_CONTENT,
      anchor: "setup",
    });
    expect(created).not.toBeNull();
    const encoded = readSectionTargetLinkParam(
      `?${created!.split("?")[1]?.split("#")[0] ?? ""}`
    );

    const exact = await resolveSectionLinkNavigation({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: encoded,
      hashAnchor: "setup",
    });
    expect(exact.blockHashNavigation).toBe(false);
    expect(exact.navigateAnchor).toBe("setup");
    expect(exact.notice).toBe("exact");
    expect(exact.cleanCitationParam).toBe(true);

    const recovered = await resolveSectionLinkNavigation({
      content: SECTION_RECOVERED_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: encoded,
      hashAnchor: "setup",
    });
    expect(recovered.blockHashNavigation).toBe(false);
    expect(recovered.navigateAnchor).toBe("getting-started");
    expect(recovered.notice).toBe("recovered");
  });

  test("ambiguous stale missing and invalid never navigate", async () => {
    const twin = await createSectionTarget({
      content: SECTION_AMBIGUOUS_CONTENT,
      uri: SECTION_FIXTURE_URI,
      anchor: "twin",
    });
    expect(twin).not.toBeNull();
    const twinUrl = buildCitationSectionUrl(
      ORIGIN,
      { uri: SECTION_FIXTURE_URI, anchor: "twin" },
      twin!
    );
    const twinEncoded = readSectionTargetLinkParam(
      `?${twinUrl!.split("?")[1]?.split("#")[0] ?? ""}`
    );
    const moreIdentical = [
      SECTION_AMBIGUOUS_CONTENT,
      "",
      "## Twin",
      "",
      "Identical twin body text.",
    ].join("\n");
    const ambiguous = await resolveSectionLinkNavigation({
      content: moreIdentical,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: twinEncoded,
      hashAnchor: "twin",
    });
    expect(ambiguous.blockHashNavigation).toBe(true);
    expect(ambiguous.navigateAnchor).toBeNull();
    expect(ambiguous.notice).toBe("ambiguous");

    const setup = await captureFixtureTarget(SECTION_FIXTURE_CONTENT, {
      anchor: "setup",
    });
    const setupUrl = buildCitationSectionUrl(
      ORIGIN,
      { uri: SECTION_FIXTURE_URI, anchor: "setup" },
      setup
    );
    const setupEncoded = readSectionTargetLinkParam(
      `?${setupUrl!.split("?")[1]?.split("#")[0] ?? ""}`
    );

    const stale = await resolveSectionLinkNavigation({
      content: SECTION_STALE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: setupEncoded,
      hashAnchor: "setup",
    });
    expect(stale.blockHashNavigation).toBe(true);
    expect(stale.navigateAnchor).toBeNull();
    expect(stale.notice).toBe("stale");

    const missing = await resolveSectionLinkNavigation({
      content: SECTION_MISSING_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: setupEncoded,
      hashAnchor: "setup",
    });
    expect(missing.blockHashNavigation).toBe(true);
    expect(missing.navigateAnchor).toBeNull();
    expect(missing.notice).toBe("missing");

    const invalid = await resolveSectionLinkNavigation({
      content: SECTION_FIXTURE_CONTENT,
      uri: SECTION_FIXTURE_URI,
      encodedTarget: "1.not-valid-base64!!!",
      hashAnchor: "setup",
    });
    expect(invalid.blockHashNavigation).toBe(true);
    expect(invalid.navigateAnchor).toBeNull();
    expect(invalid.notice).toBe("invalid_citation");
  });

  test("notice copy never embeds section bodies and strip removes st only", () => {
    for (const copy of Object.values(SECTION_LINK_NOTICE_COPY)) {
      expect(copy.includes("Install Bun")).toBe(false);
      expect(copy.includes("Identical twin")).toBe(false);
    }
    expect(
      stripSectionTargetLinkParam(
        "?uri=gno%3A%2F%2Fwork%2Fnotes%2Fpilot.md&view=rendered&st=1.abc"
      )
    ).toBe("?uri=gno%3A%2F%2Fwork%2Fnotes%2Fpilot.md&view=rendered");
  });
});
