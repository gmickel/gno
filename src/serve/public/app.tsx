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
import Search from "./pages/Search";
import "./globals.css";

type Route =
  | "/"
  | "/search"
  | "/browse"
  | "/doc"
  | "/ask"
  | "/edit"
  | "/collections";
type Navigate = (to: string | number) => void;

const routes: Record<Route, React.ComponentType<{ navigate: Navigate }>> = {
  "/": Dashboard,
  "/search": Search,
  "/browse": Browse,
  "/doc": DocView,
  "/edit": DocumentEditor,
  "/collections": Collections,
  "/ask": Ask,
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
      <Page navigate={navigate} />
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
