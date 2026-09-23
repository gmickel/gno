import { screen } from "@testing-library/react";
import { expect, mock, test } from "bun:test";

import { apiOk, renderWithUser } from "../../../helpers/dom";

const apiFetch = mock(async (...args: unknown[]) => {
  if (args[0] === "/api/capabilities")
    return apiOk({ bm25: true, vector: false, hybrid: false, answer: true });
  if (args[0] === "/api/collections") return apiOk([{ name: "notes" }]);
  if (args[0] === "/api/presets")
    return apiOk({
      activePreset: "local",
      presets: [],
      capabilities: { answer: true, hybrid: false, vector: false, bm25: true },
    });
  if (args[0] === "/api/status")
    return apiOk({ bootstrap: { models: { cachedCount: 3, totalCount: 3 } } });
  if (args[0] === "/api/models/status") return apiOk({ active: false });
  return apiOk({
    query: "decision",
    mode: "ask",
    queryLanguage: "en",
    results: [],
    meta: {
      expanded: false,
      reranked: false,
      vectorsUsed: false,
      answerGenerated: false,
      totalResults: 0,
    },
  });
});
void mock.module("../../../../src/serve/public/hooks/use-api", () => ({
  apiFetch,
}));

test("Ask reload retains collection with its metadata filter in URL and request", async () => {
  const url = new URL("http://localhost/ask?collection=notes");
  const filter = { op: "eq", key: "project", value: "atlas" };
  url.searchParams.set("filter", JSON.stringify(filter));
  window.history.replaceState({}, "", url.toString());
  const { default: Ask } =
    await import("../../../../src/serve/public/pages/Ask");
  const { user } = renderWithUser(<Ask navigate={() => undefined} />);
  const question = await screen.findByPlaceholderText(
    /Ask a question about your documents/
  );
  expect(screen.getByText("collection:notes")).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get("collection")).toBe(
    "notes"
  );
  expect(
    JSON.parse(
      new URLSearchParams(window.location.search).get("filter") ?? "null"
    )
  ).toEqual(filter);
  await user.type(question, "decision{Enter}");
  const request = apiFetch.mock.calls.find(
    ([endpoint]) => endpoint === "/api/ask"
  );
  expect(request).toBeDefined();
  if (!request) throw new Error("Missing Ask request");
  expect(JSON.parse((request[1] as { body: string }).body)).toMatchObject({
    collection: "notes",
    filter,
  });
});
