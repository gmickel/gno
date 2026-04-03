import { createContext, useContext } from "react";

import type {
  WorkspaceTab,
  WorkspaceTabBrowseState,
} from "../lib/workspace-tabs";

interface WorkspaceContextValue {
  activeTab: WorkspaceTab | null;
  updateActiveTabBrowseState: (
    nextBrowseState:
      | WorkspaceTabBrowseState
      | ((current: WorkspaceTabBrowseState) => WorkspaceTabBrowseState)
  ) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  activeTab: null,
  updateActiveTabBrowseState: () => undefined,
});

export function WorkspaceProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: WorkspaceContextValue;
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
