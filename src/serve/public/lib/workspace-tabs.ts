export interface WorkspaceTab {
  id: string;
  label: string;
  location: string;
  browseState?: WorkspaceTabBrowseState;
}

export interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export interface WorkspaceTabBrowseState {
  expandedNodeIds: string[];
}

export interface WorkspaceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const WORKSPACE_TABS_STORAGE_KEY = "gno.workspace-tabs";

function getStorage(
  storage?: WorkspaceStorageLike
): WorkspaceStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage;
}

function createTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLocationLabel(location: string): string {
  const [path, search = ""] = location.split("?");
  const params = new URLSearchParams(search);

  switch (path) {
    case "/":
      return "Home";
    case "/search":
      return "Search";
    case "/browse": {
      const collection = params.get("collection");
      const browsePath = (params.get("path") ?? "")
        .replace(/^\/+|\/+$/g, "")
        .trim();
      if (collection && browsePath) {
        const leaf = browsePath.split("/").at(-1) ?? browsePath;
        return `Browse: ${collection} / ${leaf}`;
      }
      return collection ? `Browse: ${collection}` : "Browse";
    }
    case "/ask":
      return "Ask";
    case "/collections":
      return "Collections";
    case "/connectors":
      return "Connectors";
    case "/graph":
      return "Graph";
    case "/doc":
    case "/edit": {
      const uri = params.get("uri") ?? "";
      const fallback = path === "/edit" ? "Editor" : "Document";
      if (!uri) {
        return fallback;
      }
      const label = decodeURIComponent(uri.split("/").pop() ?? fallback);
      return path === "/edit" ? `Edit: ${label}` : label;
    }
    default:
      return "Workspace";
  }
}

function isWorkspaceTabBrowseState(
  value: unknown
): value is WorkspaceTabBrowseState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.expandedNodeIds) &&
    candidate.expandedNodeIds.every((entry) => typeof entry === "string")
  );
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.location === "string" &&
    (candidate.browseState === undefined ||
      isWorkspaceTabBrowseState(candidate.browseState))
  );
}

export function loadWorkspaceState(
  currentLocation: string,
  storage?: WorkspaceStorageLike
): WorkspaceState {
  const resolved = getStorage(storage);
  const fallbackTab: WorkspaceTab = {
    id: createTabId(),
    label: getLocationLabel(currentLocation),
    location: currentLocation,
  };

  if (!resolved) {
    return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
  }

  try {
    const raw = resolved.getItem(WORKSPACE_TABS_STORAGE_KEY);
    if (!raw) {
      return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
    }
    const candidate = parsed as Record<string, unknown>;
    const tabs = Array.isArray(candidate.tabs)
      ? candidate.tabs.filter(isWorkspaceTab)
      : [];
    const activeTabId =
      typeof candidate.activeTabId === "string" ? candidate.activeTabId : "";
    if (tabs.length === 0) {
      return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
    }

    const explicitLocation = currentLocation !== "/";
    if (!explicitLocation) {
      return {
        tabs,
        activeTabId: tabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : tabs[0]!.id,
      };
    }

    const existing = tabs.find((tab) => tab.location === currentLocation);
    if (existing) {
      return { tabs, activeTabId: existing.id };
    }

    const nextTabs = [
      ...tabs,
      {
        id: createTabId(),
        label: getLocationLabel(currentLocation),
        location: currentLocation,
      },
    ];
    return {
      tabs: nextTabs,
      activeTabId: nextTabs.at(-1)?.id ?? fallbackTab.id,
    };
  } catch {
    return { tabs: [fallbackTab], activeTabId: fallbackTab.id };
  }
}

export function saveWorkspaceState(
  state: WorkspaceState,
  storage?: WorkspaceStorageLike
): void {
  const resolved = getStorage(storage);
  if (!resolved) {
    return;
  }
  resolved.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(state));
}

export function updateActiveTabLocation(
  state: WorkspaceState,
  location: string
): WorkspaceState {
  const nextTabs = state.tabs.map((tab) =>
    tab.id === state.activeTabId
      ? { ...tab, location, label: getLocationLabel(location) }
      : tab
  );
  return {
    tabs: nextTabs,
    activeTabId: state.activeTabId,
  };
}

export function createWorkspaceTab(
  state: WorkspaceState,
  location: string
): WorkspaceState {
  const tab: WorkspaceTab = {
    id: createTabId(),
    label: getLocationLabel(location),
    location,
  };
  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

export function updateActiveTabBrowseState(
  state: WorkspaceState,
  nextBrowseState:
    | WorkspaceTabBrowseState
    | ((current: WorkspaceTabBrowseState) => WorkspaceTabBrowseState)
): WorkspaceState {
  const nextTabs = state.tabs.map((tab) => {
    if (tab.id !== state.activeTabId) {
      return tab;
    }

    const currentBrowseState: WorkspaceTabBrowseState = tab.browseState ?? {
      expandedNodeIds: [],
    };
    const resolvedBrowseState =
      typeof nextBrowseState === "function"
        ? nextBrowseState(currentBrowseState)
        : nextBrowseState;

    return {
      ...tab,
      browseState: resolvedBrowseState,
    };
  });

  return {
    tabs: nextTabs,
    activeTabId: state.activeTabId,
  };
}

export function activateWorkspaceTab(
  state: WorkspaceState,
  tabId: string
): WorkspaceState {
  return {
    tabs: state.tabs,
    activeTabId: tabId,
  };
}

export function closeWorkspaceTab(
  state: WorkspaceState,
  tabId: string
): WorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return state;
  }

  const nextTabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    const fallback = {
      id: createTabId(),
      label: "Home",
      location: "/",
    };
    return {
      tabs: [fallback],
      activeTabId: fallback.id,
    };
  }

  if (state.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: state.activeTabId,
    };
  }

  const nextActive =
    nextTabs[index - 1] ?? nextTabs[index] ?? nextTabs[nextTabs.length - 1]!;
  return {
    tabs: nextTabs,
    activeTabId: nextActive.id,
  };
}
