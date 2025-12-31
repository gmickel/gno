import { ArrowLeft, ChevronRight, FileText, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Loader } from '../components/ai-elements/loader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string | number) => void;
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
  const [initialLoad, setInitialLoad] = useState(true);
  const limit = 25;

  // Parse collection from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const collection = params.get('collection');
    if (collection) {
      setSelected(collection);
    }
  }, []);

  useEffect(() => {
    apiFetch<Collection[]>('/api/collections').then(({ data }) => {
      if (data) {
        setCollections(data);
      }
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    const url = selected
      ? `/api/docs?collection=${encodeURIComponent(selected)}&limit=${limit}&offset=${offset}`
      : `/api/docs?limit=${limit}&offset=${offset}`;

    apiFetch<DocsResponse>(url).then(({ data }) => {
      setLoading(false);
      setInitialLoad(false);
      if (data) {
        setDocs((prev) =>
          offset === 0 ? data.documents : [...prev, ...data.documents]
        );
        setTotal(data.total);
      }
    });
  }, [selected, offset]);

  const handleCollectionChange = (value: string) => {
    const newSelected = value === 'all' ? '' : value;
    setSelected(newSelected);
    setOffset(0);
    setDocs([]);
    // Update URL for shareable deep-links
    const url = newSelected
      ? `/browse?collection=${encodeURIComponent(newSelected)}`
      : '/browse';
    window.history.pushState({}, '', url);
  };

  const handleLoadMore = () => {
    setOffset((prev) => prev + limit);
  };

  const getExtBadgeVariant = (ext: string) => {
    switch (ext.toLowerCase()) {
      case '.md':
      case '.markdown':
        return 'default';
      case '.pdf':
        return 'destructive';
      case '.docx':
      case '.doc':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex items-center justify-between px-8 py-4">
          <div className="flex items-center gap-4">
            <Button
              className="gap-2"
              onClick={() => navigate(-1)}
              size="sm"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <h1 className="font-semibold text-xl">Browse</h1>
          </div>
          <div className="flex items-center gap-4">
            <Select
              onValueChange={handleCollectionChange}
              value={selected || 'all'}
            >
              <SelectTrigger className="w-[200px]">
                <FolderOpen className="mr-2 size-4 text-muted-foreground" />
                <SelectValue placeholder="All Collections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Collections</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge className="font-mono" variant="outline">
              {total.toLocaleString()} docs
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        {/* Initial loading */}
        {initialLoad && loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader className="text-primary" size={32} />
            <p className="text-muted-foreground">Loading documents...</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && docs.length === 0 && (
          <div className="py-20 text-center">
            <FileText className="mx-auto mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 font-medium text-lg">No documents found</h3>
            <p className="text-muted-foreground">
              {selected
                ? 'This collection is empty'
                : 'Index some documents to get started'}
            </p>
          </div>
        )}

        {/* Document Table */}
        {docs.length > 0 && (
          <div className="animate-fade-in opacity-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50%]">Document</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead className="text-right">Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((doc, _i) => (
                  <TableRow
                    className="group cursor-pointer"
                    key={doc.docid}
                    onClick={() =>
                      navigate(`/doc?uri=${encodeURIComponent(doc.uri)}`)
                    }
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="truncate font-medium transition-colors group-hover:text-primary">
                            {doc.title || doc.relPath}
                          </div>
                          <div className="truncate font-mono text-muted-foreground text-xs">
                            {doc.relPath}
                          </div>
                        </div>
                        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className="font-mono text-xs" variant="outline">
                        {doc.collection}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        className="font-mono text-xs"
                        variant={getExtBadgeVariant(doc.sourceExt)}
                      >
                        {doc.sourceExt}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Load More */}
            {offset + limit < total && (
              <div className="mt-8 text-center">
                <Button
                  className="gap-2"
                  disabled={loading}
                  onClick={handleLoadMore}
                  variant="outline"
                >
                  {loading ? (
                    <>
                      <Loader size={16} />
                      Loading...
                    </>
                  ) : (
                    <>
                      Load More
                      <Badge className="ml-1" variant="secondary">
                        {Math.min(limit, total - docs.length)} remaining
                      </Badge>
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
