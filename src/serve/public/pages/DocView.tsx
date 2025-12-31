import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string) => void;
}

interface DocData {
  docid: string;
  uri: string;
  title: string | null;
  content: string;
  collection: string;
  relPath: string;
  source: {
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
  };
}

export default function DocView({ navigate }: PageProps) {
  const [doc, setDoc] = useState<DocData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const uri = params.get('uri');

    if (!uri) {
      setError('No document URI provided');
      setLoading(false);
      return;
    }

    // Note: This requires a /api/doc endpoint which we'll add later
    // For now, just show the URI
    setLoading(false);
    setDoc({
      docid: '',
      uri,
      title: uri.split('/').pop() || uri,
      content: 'Document content loading not yet implemented.\n\nURI: ' + uri,
      collection: '',
      relPath: '',
      source: { mime: '', ext: '' },
    });
  }, []);

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8 flex items-center gap-4">
        <button
          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
          onClick={() => navigate(-1 as unknown as string)}
        >
          &larr; Back
        </button>
        <h1 className="truncate font-semibold text-2xl">
          {doc?.title || 'Document'}
        </h1>
      </header>

      {error && (
        <div className="rounded-md bg-[hsl(var(--destructive))] p-4 text-[hsl(var(--destructive-foreground))]">
          {error}
        </div>
      )}

      {loading && (
        <div className="text-[hsl(var(--muted-foreground))]">Loading...</div>
      )}

      {doc && (
        <div className="rounded-lg bg-[hsl(var(--card))] p-6">
          <div className="mb-4 text-[hsl(var(--muted-foreground))] text-sm">
            {doc.uri}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-sm">
            {doc.content}
          </pre>
        </div>
      )}
    </div>
  );
}
