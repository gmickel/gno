import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Browse from './pages/Browse';
import Dashboard from './pages/Dashboard';
import DocView from './pages/DocView';
import Search from './pages/Search';
import './globals.css';

type Route = '/' | '/search' | '/browse' | '/doc';

const routes: Record<
  Route,
  React.ComponentType<{ navigate: (to: string) => void }>
> = {
  '/': Dashboard,
  '/search': Search,
  '/browse': Browse,
  '/doc': DocView,
};

function App() {
  const [path, setPath] = useState<string>(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, '', to);
    setPath(to);
  };

  // Extract base path for routing (ignore query params)
  const basePath = path.split('?')[0] as Route;
  const Page = routes[basePath] || Dashboard;

  return <Page navigate={navigate} />;
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
