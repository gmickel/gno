import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string) => void;
}

interface Collection {
  name: string;
  path: string;
}

interface Document {
  docid: string;
  uri: string;
  title: string | null;
  collection: string;
  relPath: string;
  sourceExt: string;
}

interface DocsResponse {
  documents: Document[];
  total: number;
  limit: number;
  offset: number;
}

export default function Browse({ navigate }: PageProps) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [docs, setDocs] = useState<Document[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  useEffect(() => {
    apiFetch<Collection[]>('/api/collections').then(({ data }) => {
      if (data) setCollections(data);
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const url = selected
      ? `/api/docs?collection=${encodeURIComponent(selected)}&limit=${limit}&offset=${offset}`
      : `/api/docs?limit=${limit}&offset=${offset}`;

    apiFetch<DocsResponse>(url).then(({ data }) => {
      setLoading(false);
      if (data) {
        setDocs(data.documents);
        setTotal(data.total);
      }
    });
  }, [selected, offset]);

  const handleLoadMore = () => {
    setOffset((prev) => prev + limit);
  };

  return (
    <div className="min-h-screen p-8">
      <header className="mb-8 flex items-center gap-4">
        <button
          className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
          onClick={() => navigate('/')}
        >
          &larr; Back
        </button>
        <h1 className="font-semibold text-2xl">Browse</h1>
      </header>

      <div className="mb-6">
        <select
          className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-2"
          onChange={(e) => {
            setSelected(e.target.value);
            setOffset(0);
          }}
          value={selected}
        >
          <option value="">All Collections</option>
          {collections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="ml-4 text-[hsl(var(--muted-foreground))]">
          {total} documents
        </span>
      </div>

      {loading && (
        <div className="text-[hsl(var(--muted-foreground))]">Loading...</div>
      )}

      <div className="space-y-2">
        {docs.map((doc) => (
          <div
            className="flex cursor-pointer items-center justify-between rounded-lg bg-[hsl(var(--card))] p-4 hover:ring-1 hover:ring-[hsl(var(--ring))]"
            key={doc.docid}
            onClick={() => navigate(`/doc?uri=${encodeURIComponent(doc.uri)}`)}
          >
            <div>
              <div className="font-medium">{doc.title || doc.relPath}</div>
              <div className="text-[hsl(var(--muted-foreground))] text-sm">
                {doc.collection} / {doc.relPath}
              </div>
            </div>
            <div className="text-[hsl(var(--muted-foreground))] text-sm">
              {doc.sourceExt}
            </div>
          </div>
        ))}
      </div>

      {docs.length > 0 && offset + limit < total && (
        <button
          className="mt-6 rounded-lg bg-[hsl(var(--muted))] px-6 py-2 text-[hsl(var(--foreground))] hover:opacity-90"
          onClick={handleLoadMore}
        >
          Load More
        </button>
      )}
    </div>
  );
}
