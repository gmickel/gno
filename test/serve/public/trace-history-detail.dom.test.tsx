import { screen } from "@testing-library/react";
import { describe, expect, mock, test } from "bun:test";

import type { RetrievalTraceDetail } from "../../../src/core/retrieval-trace-management";

import {
  TraceEvidenceList,
  TracePurgeNotice,
  traceEvidenceSelections,
} from "../../../src/serve/public/pages/trace-history-detail";
import { renderWithUser } from "../../helpers/dom";

const detail = {
  runs: [
    {
      payload: {
        ranked: [
          {
            uri: "gno://notes/evidence.md",
            docid: "#abcdef",
            sourceHash: "a".repeat(64),
            startLine: 3,
            endLine: 4,
          },
        ],
      },
    },
  ],
  events: [],
} as unknown as RetrievalTraceDetail;

describe("trace history evidence and purge truthfulness", () => {
  test("selects an exact recorded evidence span for labeling", async () => {
    expect(traceEvidenceSelections(detail)).toEqual([
      {
        ref: "gno://notes/evidence.md",
        targetKind: "span",
        startLine: 3,
        endLine: 4,
        sourceHash: "a".repeat(64),
        docid: "#abcdef",
      },
    ]);
    const onSelect = mock(() => undefined);
    const { user } = renderWithUser(
      <TraceEvidenceList detail={detail} onSelect={onSelect} />
    );
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "SPAN" &&
          (element.textContent?.includes("lines 3–4") ?? false)
      )
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Label this evidence" })
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "gno://notes/evidence.md",
        targetKind: "span",
        startLine: 3,
        endLine: 4,
      })
    );
  });

  test.each(["wal_busy", "failed"] as const)(
    "keeps %s physical cleanup visible with retry guidance",
    (physicalCleanup) => {
      renderWithUser(
        <TracePurgeNotice
          receipt={{
            schemaVersion: "1.0",
            traces: 4,
            runs: 3,
            events: 2,
            judgments: 1,
            exports: 1,
            exportLinks: 1,
            physicalCleanup,
            checkpointedFrames: physicalCleanup === "wal_busy" ? 2 : 0,
            remainingWalFrames: physicalCleanup === "wal_busy" ? 1 : -1,
          }}
        />
      );
      expect(screen.getByTestId("trace-purge-receipt").textContent).toContain(
        `physical cleanup ${physicalCleanup.replace("_", " ")}`
      );
      expect(screen.getByTestId("trace-purge-receipt").textContent).toContain(
        "Retry Full purge"
      );
    }
  );
});
