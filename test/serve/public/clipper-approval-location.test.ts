import { describe, expect, mock, test } from "bun:test";

import { consumeClipperPairLaunch } from "../../../src/serve/public/lib/clipper-approval";

describe("browser clipper approval launch", () => {
  test("accepts one exact fragment and scrubs it synchronously", () => {
    const replaceState = mock(() => undefined);
    const pairId = "a".repeat(64);
    expect(
      consumeClipperPairLaunch(
        {
          pathname: "/clipper/pair",
          search: "",
          hash: `#pairId=${pairId}`,
        } as Location,
        { replaceState } as unknown as History
      )
    ).toEqual({ pairId, valid: true });
    expect(replaceState).toHaveBeenCalledWith({}, "", "/clipper/pair");
  });

  test("rejects query strings, codes, extra fields, and malformed IDs", () => {
    for (const location of [
      {
        pathname: "/clipper/pair",
        search: "?pairId=x",
        hash: "",
      },
      {
        pathname: "/clipper/pair",
        search: "",
        hash: `#pairId=${"a".repeat(64)}&pairingCode=12345678`,
      },
      {
        pathname: "/clipper/pair",
        search: "",
        hash: "#pairId=short",
      },
    ]) {
      const replaceState = mock(() => undefined);
      expect(
        consumeClipperPairLaunch(
          location as Location,
          { replaceState } as unknown as History
        )
      ).toEqual({ pairId: null, valid: false });
      expect(replaceState).toHaveBeenCalledWith({}, "", "/clipper/pair");
    }
  });
});
