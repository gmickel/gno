export type WorkspaceActionRequestType =
  | "create-folder-here"
  | "rename-current-note"
  | "move-current-note"
  | "duplicate-current-note";

const WORKSPACE_ACTION_EVENT = "gno:workspace-action";

export function emitWorkspaceActionRequest(
  type: WorkspaceActionRequestType
): void {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_ACTION_EVENT, {
      detail: { type },
    })
  );
}

export function subscribeWorkspaceActionRequest(
  type: WorkspaceActionRequestType,
  handler: () => void
): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    if (
      typeof event.detail === "object" &&
      event.detail &&
      "type" in event.detail &&
      event.detail.type === type
    ) {
      handler();
    }
  };

  window.addEventListener(WORKSPACE_ACTION_EVENT, listener);
  return () => window.removeEventListener(WORKSPACE_ACTION_EVENT, listener);
}
