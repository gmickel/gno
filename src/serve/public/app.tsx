import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

import { HelpButton } from "./components/HelpButton";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { CaptureModalProvider, useCaptureModal } from "./hooks/useCaptureModal";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { WorkspaceProvider } from "./hooks/useWorkspace";
import { consumeClipperPairLaunch } from "./lib/clipper-approval";
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
import ClipperPairing from "./pages/ClipperPairing";
import Dashboard from "./pages/Dashboard";

const QuickSwitcher = lazy(() =>
  import("./components/QuickSwitcher").then((module) => ({
    default: module.QuickSwitcher,
  }))
);
const ShortcutHelpModal = lazy(() =>
  import("./components/ShortcutHelpModal").then((module) => ({
    default: module.ShortcutHelpModal,
  }))
);
const Search = lazy(() => import("./pages/Search"));
const Browse = lazy(() => import("./pages/Browse"));
const DocView = lazy(() => import("./pages/DocView"));
const DocumentEditor = lazy(() => import("./pages/DocumentEditor"));
const Collections = lazy(() => import("./pages/Collections"));
const Connectors = lazy(() => import("./pages/Connectors"));
const Ask = lazy(() => import("./pages/Ask"));
const GraphView = lazy(() => import("./pages/GraphView"));
const CompiledContext = lazy(() => import("./pages/CompiledContext"));
const TraceHistory = lazy(() => import("./pages/TraceHistory"));

type Route =
  | "/"
  | "/search"
  | "/browse"
  | "/doc"
  | "/ask"
  | "/edit"
  | "/collections"
  | "/graph"
  | "/connectors"
  | "/context/compiled"
  | "/traces";
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
  "/traces": TraceHistory,
  "/context/compiled": CompiledContext,
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
          <Suspense fallback={null}>
            <Page key={pageKey} location={location} navigate={navigate} />
          </Suspense>
        </div>
        <footer className="border-t border-border/30 bg-background/60 py-6 text-center text-sm backdrop-blur-sm">
          <div className="ornament mx-auto mb-4 max-w-[8rem] text-muted-foreground/20">
            <span className="text-[10px]">◆</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 px-4 text-muted-foreground/60 sm:gap-x-5">
            <button
              className="transition-colors duration-300 hover:text-primary"
              onClick={() => navigate("/collections")}
              type="button"
            >
              Collections
            </button>
            <span className="text-border/30">—</span>
            <button
              className="transition-colors duration-300 hover:text-primary"
              onClick={() => navigate("/traces")}
              type="button"
            >
              Trace history
            </button>
            <span className="text-border/30">—</span>
            <button
              className="transition-colors duration-300 hover:text-primary"
              onClick={() => navigate("/context/compiled")}
              type="button"
            >
              Compiled context
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
      <Suspense fallback={null}>
        <QuickSwitcher
          location={location}
          navigate={(to) => navigate(to)}
          onCreateNote={openCapture}
          onOpenChange={setQuickSwitcherOpen}
          open={quickSwitcherOpen}
        />
        <ShortcutHelpModal
          onOpenChange={setShortcutHelpOpen}
          open={shortcutHelpOpen}
        />
      </Suspense>
    </>
  );
}

function App() {
  const initialLocation =
    window.location.pathname + window.location.search + window.location.hash;
  const [workspace, setWorkspace] = useState<WorkspaceState>(() =>
    loadWorkspaceState(initialLocation)
  );
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ??
    workspace.tabs[0];
  const location = activeTab?.location ?? "/";

  useEffect(() => {
    const currentLocation =
      window.location.pathname + window.location.search + window.location.hash;
    if (location !== currentLocation) {
      window.history.replaceState({}, "", location);
    }
  }, [location]);

  useEffect(() => {
    const handlePopState = () => {
      setWorkspace((current) =>
        updateActiveTabLocation(
          current,
          window.location.pathname +
            window.location.search +
            window.location.hash
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
if (window.location.pathname === "/clipper/pair") {
  const launch = consumeClipperPairLaunch(window.location, window.history);
  root.render(<ClipperPairing pairId={launch.pairId} />);
} else {
  root.render(<App />);
}
