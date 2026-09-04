import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";

import {
  IndexingProgress,
  type JobStatus,
} from "../../../../src/serve/public/components/IndexingProgress";

interface PendingRequest {
  signal: AbortSignal;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const pending: PendingRequest[] = [];
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let timeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;

const running: JobStatus = {
  id: "job",
  type: "sync",
  status: "running",
  createdAt: 0,
};
const completed: JobStatus = {
  ...running,
  status: "completed",
  result: {
    collections: [],
    totalDurationMs: 100,
    totalFilesProcessed: 1,
    totalFilesAdded: 1,
    totalFilesUpdated: 0,
    totalFilesErrored: 0,
    totalFilesSkipped: 0,
  },
};

beforeEach(() => {
  pending.length = 0;
  const fakeFetch = (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      pending.push({ signal: init!.signal!, resolve, reject });
    });
  };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(fakeFetch, { preconnect: globalThis.fetch.preconnect })
  );
  timeoutSpy = spyOn(globalThis, "setTimeout");
});

afterEach(() => {
  cleanup();
  timeoutSpy.mockRestore();
  fetchSpy.mockRestore();
});

async function settle(
  request: PendingRequest,
  result: JobStatus | Error | null
) {
  await act(async () => {
    if (result instanceof Error) {
      request.reject(result);
    } else {
      request.resolve(Response.json(result));
    }
  });
}

test.each([
  ["running success", running],
  ["completed success", completed],
  ["job failure", { ...running, status: "failed", error: "failed" }],
  ["network failure", new Error("network failure")],
  ["abort rejection", new DOMException("Aborted", "AbortError")],
  ["empty response", null],
] as const)("cleanup ignores deferred %s", async (_name, response) => {
  const onComplete = mock();
  const onError = mock();
  const view = render(
    <IndexingProgress jobId="job" onComplete={onComplete} onError={onError} />
  );
  const request = pending[0]!;
  view.unmount();
  expect(request.signal.aborted).toBe(true);
  const scheduled = timeoutSpy.mock.calls.length;
  await settle(request, response);
  expect(timeoutSpy.mock.calls.length).toBe(scheduled);
  expect(pending).toHaveLength(1);
  expect(onComplete).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("");
});

test("effect restart rejects old state and callback while new owner completes", async () => {
  const oldComplete = mock();
  const newComplete = mock();
  const view = render(
    <IndexingProgress jobId="old" onComplete={oldComplete} />
  );
  const old = pending[0]!;
  view.rerender(<IndexingProgress jobId="new" onComplete={newComplete} />);
  const current = pending[1]!;
  expect(old.signal.aborted).toBe(true);
  expect(current.signal.aborted).toBe(false);
  await settle(old, completed);
  expect(screen.getByText("Loading...")).toBeTruthy();
  expect(oldComplete).not.toHaveBeenCalled();
  expect(newComplete).not.toHaveBeenCalled();
  await settle(current, completed);
  expect(screen.getByText("Indexing complete")).toBeTruthy();
  expect(newComplete).toHaveBeenCalledTimes(1);
});

test("repeated remounts keep one loop and cleanup cancels its timer", async () => {
  const oldRequests: PendingRequest[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = render(<IndexingProgress jobId="job" />);
    oldRequests.push(pending.at(-1)!);
    previous.unmount();
  }
  const view = render(<IndexingProgress jobId="job" />);
  const current = pending.at(-1)!;
  const scheduled = timeoutSpy.mock.calls.length;
  for (const request of oldRequests) {
    await settle(request, running);
  }
  expect(timeoutSpy.mock.calls.length).toBe(scheduled);
  expect(current.signal.aborted).toBe(false);
  await settle(current, running);
  expect(screen.getByText("Indexing in progress")).toBeTruthy();
  expect(timeoutSpy.mock.calls.length).toBe(scheduled + 1);
  // Cross the real poll interval: only the surviving owner sends a request.
  await act(async () => {
    await Bun.sleep(1100);
  });
  expect(pending).toHaveLength(5);
  await settle(pending[4]!, running);
  view.unmount();
  await Bun.sleep(1100);
  expect(pending).toHaveLength(5);
});
