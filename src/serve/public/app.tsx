import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Ask from './pages/Ask';
import Browse from './pages/Browse';
import Dashboard from './pages/Dashboard';
import DocView from './pages/DocView';
import Search from './pages/Search';
import './globals.css';

type Route = '/' | '/search' | '/browse' | '/doc' | '/ask';
type Navigate = (to: string | number) => void;

const routes: Record<Route, React.ComponentType<{ navigate: Navigate }>> = {
  '/': Dashboard,
  '/search': Search,
  '/browse': Browse,
  '/doc': DocView,
  '/ask': Ask,
};

function App() {
  // Track full location (pathname + search) for proper query param handling
  const [location, setLocation] = useState<string>(
    window.location.pathname + window.location.search
  );

  useEffect(() => {
    const handlePopState = () =>
      setLocation(window.location.pathname + window.location.search);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (to: string | number) => {
    if (typeof to === 'number') {
      // Handle history.go(-1) style navigation
      window.history.go(to);
      return;
    }
    window.history.pushState({}, '', to);
    setLocation(to);
  };

  // Extract base path for routing (ignore query params)
  const basePath = location.split('?')[0] as Route;
  const Page = routes[basePath] || Dashboard;

  return <Page navigate={navigate} />;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}
const root = createRoot(rootElement);
root.render(<App />);
