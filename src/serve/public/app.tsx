import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { HelpButton } from "./components/HelpButton";
import { ShortcutHelpModal } from "./components/ShortcutHelpModal";
import { CaptureModalProvider } from "./hooks/useCaptureModal";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import Ask from "./pages/Ask";
import Browse from "./pages/Browse";
import Collections from "./pages/Collections";
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
  | "/graph";
type Navigate = (to: string | number) => void;

const routes: Record<Route, React.ComponentType<{ navigate: Navigate }>> = {
  "/": Dashboard,
  "/search": Search,
  "/browse": Browse,
  "/doc": DocView,
  "/edit": DocumentEditor,
  "/collections": Collections,
  "/ask": Ask,
  "/graph": GraphView,
};

function App() {
  // Track full location (pathname + search) for proper query param handling
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
      // Handle history.go(-1) style navigation
      window.history.go(to);
      return;
    }
    window.history.pushState({}, "", to);
    setLocation(to);
    // Dispatch event for components that need to react to URL changes
    window.dispatchEvent(new CustomEvent("locationchange", { detail: to }));
  }, []);

  // Global keyboard shortcuts (single-key, GitHub/Gmail pattern)
  const shortcuts = useMemo(
    () => [
      {
        key: "/",
        action: () => {
          // Focus search input on current page or navigate to search
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
    ],
    [navigate]
  );

  useKeyboardShortcuts(shortcuts);

  // Extract base path for routing (ignore query params)
  const basePath = location.split("?")[0] as Route;
  const Page = routes[basePath] || Dashboard;

  return (
    <CaptureModalProvider>
      <div className="flex min-h-screen flex-col">
        <div className="flex-1">
          <Page navigate={navigate} />
        </div>
        <footer className="border-t border-border/50 bg-background/80 py-4 text-center text-muted-foreground text-sm">
          <div className="flex items-center justify-center gap-4">
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
              href="https://discord.gg/ST5Y39hQ"
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
          </div>
        </footer>
      </div>
      <HelpButton onClick={() => setShortcutHelpOpen(true)} />
      <ShortcutHelpModal
        onOpenChange={setShortcutHelpOpen}
        open={shortcutHelpOpen}
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
