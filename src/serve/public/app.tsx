import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { HelpButton } from "./components/HelpButton";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { ShortcutHelpModal } from "./components/ShortcutHelpModal";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { CaptureModalProvider, useCaptureModal } from "./hooks/useCaptureModal";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { parseDocumentDeepLink } from "./lib/deep-links";
import { saveRecentDocument } from "./lib/navigation-state";
import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTab,
  loadWorkspaceState,
  saveWorkspaceState,
  updateActiveTabLocation,
  updateActiveTabBrowseState,
  type WorkspaceState,
} from "./lib/workspace-tabs";
import Ask from "./pages/Ask";
import Browse from "./pages/Browse";
import Collections from "./pages/Collections";
import Connectors from "./pages/Connectors";
import Dashboard from "./pages/Dashboard";
import DocumentEditor from "./pages/DocumentEditor";
import DocView from "./pages/DocView";
import GraphView from "./pages/GraphView";
import Search from "./pages/Search";

type Route =
  | "/"
  | "/search"
  | "/browse"
  | "/doc"
  | "/ask"
  | "/edit"
  | "/collections"
  | "/graph"
  | "/connectors";
type Navigate = (to: string | number) => void;

interface RoutePageProps {
  navigate: Navigate;
  location?: string;
}

const routes: Record<Route, React.ComponentType<RoutePageProps>> = {
  "/": Dashboard,
  "/search": Search,
  "/browse": Browse,
  "/doc": DocView,
  "/edit": DocumentEditor,
  "/collections": Collections,
  "/connectors": Connectors,
  "/ask": Ask,
  "/graph": GraphView,
};

interface AppContentProps {
  location: string;
  navigate: Navigate;
  shortcutHelpOpen: boolean;
  setShortcutHelpOpen: (open: boolean) => void;
  workspace: WorkspaceState;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

function AppContent({
  location,
  navigate,
  onActivateTab,
  onCloseTab,
  onNewTab,
  shortcutHelpOpen,
  setShortcutHelpOpen,
  workspace,
}: AppContentProps) {
  const { openCapture } = useCaptureModal();
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);

  useEffect(() => {
    const basePath = location.split("?")[0];
    if (basePath !== "/doc" && basePath !== "/edit") {
      return;
    }

    const search = location.includes("?")
      ? `?${location.split("?")[1] ?? ""}`
      : "";
    const target = parseDocumentDeepLink(search);
    if (!target.uri) {
      return;
    }

    saveRecentDocument({
      uri: target.uri,
      href: location,
      label: decodeURIComponent(target.uri.split("/").pop() ?? target.uri),
    });
  }, [location]);

  const shortcuts = useMemo(
    () => [
      {
        key: "/",
        action: () => {
          const searchInput = document.querySelector<HTMLInputElement>(
            'input[type="search"], input[placeholder*="Search"], input[id*="search"]'
          );
          if (searchInput) {
            searchInput.focus();
            searchInput.select();
          } else {
            navigate("/search");
          }
        },
      },
      {
        key: "?",
        action: () => setShortcutHelpOpen(true),
      },
      {
        key: "k",
        meta: true,
        action: () => setQuickSwitcherOpen(true),
      },
    ],
    [navigate, setShortcutHelpOpen]
  );

  useKeyboardShortcuts(shortcuts);

  const basePath = location.split("?")[0] as Route;
  const Page = routes[basePath] || Dashboard;
  const pageKey = basePath === "/browse" ? basePath : location;

  return (
    <>
      <div className="flex min-h-screen flex-col">
        <WorkspaceTabs
          activeTabId={workspace.activeTabId}
          onActivate={onActivateTab}
          onClose={onCloseTab}
          onNewTab={onNewTab}
          tabs={workspace.tabs}
        />
        <div className="flex-1">
          <Page key={pageKey} location={location} navigate={navigate} />
        </div>
        <footer className="border-t border-border/30 bg-background/60 py-6 text-center text-sm backdrop-blur-sm">
          <div className="ornament mx-auto mb-4 max-w-[8rem] text-muted-foreground/20">
            <span className="text-[10px]">◆</span>
          </div>
          <div className="flex items-center justify-center gap-5 text-muted-foreground/60">
            <button
              className="transition-colors duration-300 hover:text-primary"
              onClick={() => navigate("/collections")}
              type="button"
            >
              Collections
            </button>
            <span className="text-border/30">—</span>
            <a
              className="transition-colors duration-300 hover:text-primary"
              href="https://github.com/gmickel/gno"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </a>
            <span className="text-border/30">—</span>
            <a
              className="transition-colors duration-300 hover:text-primary"
              href="https://discord.gg/nHEmyJB5tg"
              rel="noopener noreferrer"
              target="_blank"
            >
              Discord
            </a>
            <span className="text-border/30">—</span>
            <a
              className="transition-colors duration-300 hover:text-primary"
              href="https://gno.sh"
              rel="noopener noreferrer"
              target="_blank"
            >
              gno.sh
            </a>
            <span className="text-border/30">—</span>
            <a
              className="transition-colors duration-300 hover:text-primary"
              href="https://twitter.com/gmickel"
              rel="noopener noreferrer"
              target="_blank"
            >
              Twitter
            </a>
          </div>
        </footer>
      </div>
      <HelpButton onClick={() => setShortcutHelpOpen(true)} />
      <QuickSwitcher
        navigate={(to) => navigate(to)}
        onCreateNote={openCapture}
        onOpenChange={setQuickSwitcherOpen}
        open={quickSwitcherOpen}
      />
      <ShortcutHelpModal
        onOpenChange={setShortcutHelpOpen}
        open={shortcutHelpOpen}
      />
    </>
  );
}

function App() {
  const initialLocation = window.location.pathname + window.location.search;
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    loadWorkspaceState(initialLocation)
  );
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ??
    workspace.tabs[0];
  const location = activeTab?.location ?? "/";

  useEffect(() => {
    const currentLocation = window.location.pathname + window.location.search;
    if (location !== currentLocation) {
      window.history.replaceState({}, "", location);
    }
  }, [location]);

  useEffect(() => {
    const handlePopState = () => {
      setWorkspace((current) =>
        updateActiveTabLocation(
          current,
          window.location.pathname + window.location.search
        )
      );
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    saveWorkspaceState(workspace);
  }, [workspace]);

  const navigate = useCallback((to: string | number) => {
    if (typeof to === "number") {
      window.history.go(to);
      return;
    }
    window.history.pushState({}, "", to);
    setWorkspace((current) => updateActiveTabLocation(current, to));
  }, []);

  const activateTab = useCallback((tabId: string) => {
    setWorkspace((current) => {
      const next = activateWorkspaceTab(current, tabId);
      const tab =
        next.tabs.find((entry) => entry.id === next.activeTabId) ??
        next.tabs[0];
      if (tab) {
        window.history.pushState({}, "", tab.location);
      }
      return next;
    });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    setWorkspace((current) => {
      const next = closeWorkspaceTab(current, tabId);
      const tab =
        next.tabs.find((entry) => entry.id === next.activeTabId) ??
        next.tabs[0];
      if (tab) {
        window.history.replaceState({}, "", tab.location);
      }
      return next;
    });
  }, []);

  const openNewTab = useCallback(() => {
    setWorkspace((current) => {
      const next = createWorkspaceTab(current, "/search");
      const tab =
        next.tabs.find((entry) => entry.id === next.activeTabId) ??
        next.tabs[0];
      if (tab) {
        window.history.pushState({}, "", tab.location);
      }
      return next;
    });
  }, []);

  const updateActiveBrowseState = useCallback(
    (nextBrowseState: Parameters<typeof updateActiveTabBrowseState>[1]) => {
      setWorkspace((current) =>
        updateActiveTabBrowseState(current, nextBrowseState)
      );
    },
    []
  );

  return (
    <WorkspaceProvider
      value={{
        activeTab: activeTab ?? null,
        updateActiveTabBrowseState: updateActiveBrowseState,
      }}
    >
      <CaptureModalProvider>
        <AppContent
          location={location}
          navigate={navigate}
          onActivateTab={activateTab}
          onCloseTab={closeTab}
          onNewTab={openNewTab}
          setShortcutHelpOpen={setShortcutHelpOpen}
          shortcutHelpOpen={shortcutHelpOpen}
          workspace={workspace}
        />
      </CaptureModalProvider>
    </WorkspaceProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}
const root = createRoot(rootElement);
root.render(<App />);
