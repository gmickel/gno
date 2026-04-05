import { parseBrowseLocation } from "./browse";
import { emitWorkspaceActionRequest } from "./workspace-events";

export type WorkspaceActionId =
  | "new-note"
  | "new-note-in-context"
  | "create-folder-here"
  | "rename-current-note"
  | "move-current-note"
  | "duplicate-current-note"
  | "go-home"
  | "go-search"
  | "go-browse"
  | "go-ask"
  | "go-graph"
  | "go-collections"
  | "go-connectors";

export interface WorkspaceAction {
  id: WorkspaceActionId;
  group: "Create" | "Go To";
  label: string;
  description?: string;
  keywords: string[];
  available: boolean;
}

export interface WorkspaceActionContext {
  location: string;
}

export interface WorkspaceActionHandlers {
  navigate: (to: string) => void;
  openCapture: (options?: {
    draftTitle?: string;
    defaultCollection?: string;
    defaultFolderPath?: string;
    presetId?: string;
  }) => void;
  closePalette: () => void;
}

export function getWorkspaceActions(
  context: WorkspaceActionContext
): WorkspaceAction[] {
  const selection = parseBrowseLocation(
    context.location.includes("?")
      ? `?${context.location.split("?")[1] ?? ""}`
      : ""
  );
  const hasBrowseContext = Boolean(selection.collection);
  const isDocView = context.location.startsWith("/doc?");

  return [
    {
      id: "new-note",
      group: "Create",
      label: "New note",
      description: "Open note capture",
      keywords: ["new", "note", "capture", "create"],
      available: true,
    },
    {
      id: "new-note-in-context",
      group: "Create",
      label: "New note in current location",
      description: hasBrowseContext
        ? `Create in ${selection.collection}${
            selection.path ? ` / ${selection.path}` : ""
          }`
        : "Requires a selected collection in Browse",
      keywords: ["new", "note", "folder", "browse", "collection", "create"],
      available: hasBrowseContext,
    },
    {
      id: "create-folder-here",
      group: "Create",
      label: "Create folder here",
      description: hasBrowseContext
        ? "Create a folder in the current Browse location"
        : "Requires a selected collection in Browse",
      keywords: ["folder", "browse", "create", "directory"],
      available: hasBrowseContext,
    },
    {
      id: "rename-current-note",
      group: "Create",
      label: "Rename current note",
      description: "Open rename dialog for the active note",
      keywords: ["rename", "current", "note", "document"],
      available: isDocView,
    },
    {
      id: "move-current-note",
      group: "Create",
      label: "Move current note",
      description: "Open move dialog for the active note",
      keywords: ["move", "current", "note", "document"],
      available: isDocView,
    },
    {
      id: "duplicate-current-note",
      group: "Create",
      label: "Duplicate current note",
      description: "Open duplicate dialog for the active note",
      keywords: ["duplicate", "copy", "current", "note", "document"],
      available: isDocView,
    },
    {
      id: "go-home",
      group: "Go To",
      label: "Home",
      keywords: ["home", "dashboard"],
      available: true,
    },
    {
      id: "go-search",
      group: "Go To",
      label: "Search",
      keywords: ["search", "find", "query"],
      available: true,
    },
    {
      id: "go-browse",
      group: "Go To",
      label: "Browse",
      keywords: ["browse", "tree", "folders"],
      available: true,
    },
    {
      id: "go-ask",
      group: "Go To",
      label: "Ask",
      keywords: ["ask", "answer", "rag"],
      available: true,
    },
    {
      id: "go-graph",
      group: "Go To",
      label: "Graph",
      keywords: ["graph", "links", "relationships"],
      available: true,
    },
    {
      id: "go-collections",
      group: "Go To",
      label: "Collections",
      keywords: ["collections", "sources", "folders"],
      available: true,
    },
    {
      id: "go-connectors",
      group: "Go To",
      label: "Connectors",
      keywords: ["connectors", "mcp", "skills", "agents"],
      available: true,
    },
  ];
}

export function runWorkspaceAction(
  action: WorkspaceAction,
  context: WorkspaceActionContext,
  handlers: WorkspaceActionHandlers,
  query?: string
): void {
  const selection = parseBrowseLocation(
    context.location.includes("?")
      ? `?${context.location.split("?")[1] ?? ""}`
      : ""
  );

  switch (action.id) {
    case "new-note":
      handlers.openCapture({ draftTitle: query?.trim() || undefined });
      handlers.closePalette();
      return;
    case "new-note-in-context":
      handlers.openCapture({
        draftTitle: query?.trim() || undefined,
        defaultCollection: selection.collection || undefined,
        defaultFolderPath: selection.path || undefined,
      });
      handlers.closePalette();
      return;
    case "create-folder-here":
      emitWorkspaceActionRequest("create-folder-here");
      handlers.closePalette();
      return;
    case "rename-current-note":
      emitWorkspaceActionRequest("rename-current-note");
      handlers.closePalette();
      return;
    case "move-current-note":
      emitWorkspaceActionRequest("move-current-note");
      handlers.closePalette();
      return;
    case "duplicate-current-note":
      emitWorkspaceActionRequest("duplicate-current-note");
      handlers.closePalette();
      return;
    case "go-home":
      handlers.navigate("/");
      break;
    case "go-search":
      handlers.navigate("/search");
      break;
    case "go-browse":
      handlers.navigate("/browse");
      break;
    case "go-ask":
      handlers.navigate("/ask");
      break;
    case "go-graph":
      handlers.navigate("/graph");
      break;
    case "go-collections":
      handlers.navigate("/collections");
      break;
    case "go-connectors":
      handlers.navigate("/connectors");
      break;
  }

  handlers.closePalette();
}
