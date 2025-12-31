import {
  ArrowLeft,
  Calendar,
  FileText,
  FolderOpen,
  HardDrive,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  CodeBlock,
  CodeBlockCopyButton,
} from '../components/ai-elements/code-block';
import { Loader } from '../components/ai-elements/loader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Separator } from '../components/ui/separator';
import { apiFetch } from '../hooks/use-api';

interface PageProps {
  navigate: (to: string | number) => void;
}

interface DocData {
  docid: string;
  uri: string;
  title: string | null;
  content: string | null;
  contentAvailable: boolean;
  collection: string;
  relPath: string;
  source: {
    mime: string;
    ext: string;
    modifiedAt?: string;
    sizeBytes?: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B';
  }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

// Shiki BundledLanguage subset we actually use
type SupportedLanguage =
  | 'markdown'
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'rust'
  | 'go'
  | 'json'
  | 'yaml'
  | 'html'
  | 'css'
  | 'sql'
  | 'bash'
  | 'text';

function getLanguageFromExt(ext: string): SupportedLanguage {
  const map: Record<string, SupportedLanguage> = {
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.html': 'html',
    '.css': 'css',
    '.sql': 'sql',
    '.sh': 'bash',
    '.bash': 'bash',
  };
  return map[ext.toLowerCase()] || 'text';
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

    apiFetch<DocData>(`/api/doc?uri=${encodeURIComponent(uri)}`).then(
      ({ data, error }) => {
        setLoading(false);
        if (error) {
          setError(error);
        } else if (data) {
          setDoc(data);
        }
      }
    );
  }, []);

  const isCodeFile =
    doc?.source.ext &&
    [
      '.md',
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.py',
      '.rs',
      '.go',
      '.json',
      '.yaml',
      '.yml',
      '.html',
      '.css',
      '.sql',
      '.sh',
      '.bash',
    ].includes(doc.source.ext.toLowerCase());

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="glass sticky top-0 z-10 border-border/50 border-b">
        <div className="flex items-center gap-4 px-8 py-4">
          <Button
            className="gap-2"
            onClick={() => navigate(-1)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <Separator className="h-6" orientation="vertical" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate font-semibold text-xl">
              {doc?.title || 'Document'}
            </h1>
          </div>
          {doc?.source.ext && (
            <Badge className="shrink-0 font-mono" variant="outline">
              {doc.source.ext}
            </Badge>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-8">
        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader className="text-primary" size={32} />
            <p className="text-muted-foreground">Loading document...</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="py-6 text-center">
              <FileText className="mx-auto mb-4 size-12 text-destructive" />
              <h3 className="mb-2 font-medium text-destructive text-lg">
                Failed to load document
              </h3>
              <p className="text-muted-foreground">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Document */}
        {doc && (
          <div className="animate-fade-in space-y-6 opacity-0">
            {/* Metadata */}
            <Card>
              <CardContent className="py-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="size-4 text-muted-foreground" />
                    <div>
                      <div className="text-muted-foreground text-xs">
                        Collection
                      </div>
                      <div className="font-medium">
                        {doc.collection || 'Unknown'}
                      </div>
                    </div>
                  </div>
                  {doc.source.sizeBytes !== undefined && (
                    <div className="flex items-center gap-3">
                      <HardDrive className="size-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Size
                        </div>
                        <div className="font-medium">
                          {formatBytes(doc.source.sizeBytes)}
                        </div>
                      </div>
                    </div>
                  )}
                  {doc.source.modifiedAt && (
                    <div className="flex items-center gap-3">
                      <Calendar className="size-4 text-muted-foreground" />
                      <div>
                        <div className="text-muted-foreground text-xs">
                          Modified
                        </div>
                        <div className="font-medium">
                          {formatDate(doc.source.modifiedAt)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-4 border-border/50 border-t pt-4">
                  <div className="mb-1 text-muted-foreground text-xs">Path</div>
                  <code className="break-all font-mono text-muted-foreground text-sm">
                    {doc.uri}
                  </code>
                </div>
              </CardContent>
            </Card>

            {/* Content */}
            <Card>
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FileText className="size-4" />
                  Content
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                {!doc.contentAvailable && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center">
                    <p className="text-muted-foreground">
                      Content not available (document may need re-indexing)
                    </p>
                  </div>
                )}
                {doc.contentAvailable && isCodeFile && (
                  <CodeBlock
                    code={doc.content ?? ''}
                    language={getLanguageFromExt(doc.source.ext)}
                    showLineNumbers
                  >
                    <CodeBlockCopyButton />
                  </CodeBlock>
                )}
                {doc.contentAvailable && !isCodeFile && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-6">
                    <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
                      {doc.content}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
