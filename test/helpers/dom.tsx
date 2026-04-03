import type { ReactElement } from "react";

import { render, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export function renderWithUser(
  ui: ReactElement,
  options?: Omit<RenderOptions, "queries">
) {
  return {
    user: userEvent.setup(),
    ...render(ui, options),
  };
}

export function setTestLocation(path: string): void {
  window.history.replaceState({}, "", path);
}

export function apiOk<T>(data: T): Promise<{ data: T; error: null }> {
  return Promise.resolve({ data, error: null });
}

export function apiError(
  error: string
): Promise<{ data: null; error: string }> {
  return Promise.resolve({ data: null, error });
}
