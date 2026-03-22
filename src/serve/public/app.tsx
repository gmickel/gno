import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { HelpButton } from "./components/HelpButton";
import { QuickSwitcher, saveRecentDocument } from "./components/QuickSwitcher";
import { ShortcutHelpModal } from "./components/ShortcutHelpModal";
import { CaptureModalProvider, useCaptureModal } from "./hooks/useCaptureModal";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { parseDocumentDeepLink } from "./lib/deep-links";
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

const routes: Record<Route, React.ComponentType<{ navigate: Navigate }>> = {
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
}

function AppContent({
  location,
  navigate,
  shortcutHelpOpen,
  setShortcutHelpOpen,
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

  return (
    <>
      <div className="flex min-h-screen flex-col">
        <div className="flex-1">
          <Page key={location} navigate={navigate} />
        </div>
        <footer className="border-t border-border/50 bg-background/80 py-4 text-center text-muted-foreground text-sm">
          <div className="flex items-center justify-center gap-4">
            <button
              className="transition-colors hover:text-foreground"
              onClick={() => navigate("/collections")}
              type="button"
            >
              Collections
            </button>
            <span className="text-border">·</span>
            <a
              className="transition-colors hover:text-foreground"
              href="https://github.com/gmickel/gno"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </a>
            <span className="text-border">·</span>
            <a
              className="transition-colors hover:text-foreground"
              href="https://discord.gg/nHEmyJB5tg"
              rel="noopener noreferrer"
              target="_blank"
            >
              Discord
            </a>
            <span className="text-border">·</span>
            <a
              className="transition-colors hover:text-foreground"
              href="https://gno.sh"
              rel="noopener noreferrer"
              target="_blank"
            >
              gno.sh
            </a>
            <span className="text-border">·</span>
            <a
              className="transition-colors hover:text-foreground"
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
  const [location, setLocation] = useState<string>(
    window.location.pathname + window.location.search
  );
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  useEffect(() => {
    const handlePopState = () =>
      setLocation(window.location.pathname + window.location.search);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((to: string | number) => {
    if (typeof to === "number") {
      window.history.go(to);
      return;
    }
    window.history.pushState({}, "", to);
    setLocation(to);
  }, []);

  return (
    <CaptureModalProvider>
      <AppContent
        location={location}
        navigate={navigate}
        setShortcutHelpOpen={setShortcutHelpOpen}
        shortcutHelpOpen={shortcutHelpOpen}
      />
    </CaptureModalProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}
const root = createRoot(rootElement);
root.render(<App />);
