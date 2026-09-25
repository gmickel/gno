import {
  ArchiveIcon,
  InfoIcon,
  Loader2Icon,
  MessagesSquareIcon,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  SessionImportReceipt,
  SessionsStatus,
} from "../components/sessions/api";

import { sessionsApi } from "../components/sessions/api";
import { SessionSearch } from "../components/sessions/SessionSearch";
import { SourcesPanel } from "../components/sessions/SourcesPanel";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { fetchServerCapabilities } from "../lib/server-capabilities";

interface PageProps {
  navigate: (to: string | number) => void;
}

/** Codes meaning "this instance is not a usable session archive". */
const UNBOUND_CODES = new Set([
  "SESSIONS_NOT_CONFIGURED",
  "SESSIONS_BINDING_MISMATCH",
]);

const INIT_COMMAND =
  "gno --config <archive.yml> --index sessions sessions init --archive <dir> --collection <name>";
const SERVE_COMMAND = "gno --config <archive.yml> --index sessions serve";

function CommandLine({ children }: { children: string }) {
  return (
    <code className="block whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
      {children}
    </code>
  );
}

function InitForm({ onDone }: { onDone: () => Promise<void> }) {
  const [archive, setArchive] = useState("");
  const [collection, setCollection] = useState("sessions");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    const result = await sessionsApi("/api/sessions/init", {
      method: "POST",
      body: JSON.stringify({
        archive: archive.trim(),
        collection: collection.trim(),
      }),
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    await onDone();
  };

  return (
    <form
      aria-label="Create session archive"
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      <label className="grid gap-1 text-sm" htmlFor="sessions-init-archive">
        Archive directory (absolute path)
        <Input
          id="sessions-init-archive"
          onChange={(event) => setArchive(event.currentTarget.value)}
          placeholder="/home/me/agent-archive"
          required
          value={archive}
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="sessions-init-collection">
        First archive collection
        <Input
          id="sessions-init-collection"
          onChange={(event) => setCollection(event.currentTarget.value)}
          pattern="[a-z0-9][a-z0-9_-]{0,63}"
          required
          value={collection}
        />
      </label>
      {error && (
        <p
          className="break-words text-destructive text-sm sm:col-span-2"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button disabled={saving} type="submit">
          {saving && <Loader2Icon className="animate-spin" />}
          Create archive for this instance
        </Button>
        <p className="mt-2 text-muted-foreground text-xs">
          Only works when this server was started with a dedicated archive
          config and a named index; the default config is refused.
        </p>
      </div>
    </form>
  );
}

export default function Sessions({ navigate }: PageProps) {
  const [status, setStatus] = useState<SessionsStatus | null>(null);
  const [unbound, setUnbound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [localClient, setLocalClient] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<
    Record<string, SessionImportReceipt>
  >({});
  // Bumped when an action (import/remove) fails so focus moves to the alert
  // instead of dropping to <body> from the disabled button.
  const [actionErrorCount, setActionErrorCount] = useState(0);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (actionErrorCount > 0) errorRef.current?.focus();
  }, [actionErrorCount]);

  const loadStatus = useCallback(async () => {
    const result = await sessionsApi<SessionsStatus>("/api/sessions/status");
    setLoading(false);
    if (result.data) {
      setStatus(result.data);
      setUnbound(null);
      setError(null);
      return;
    }
    setStatus(null);
    if (result.sessionsCode && UNBOUND_CODES.has(result.sessionsCode)) {
      setUnbound(result.error);
      setError(null);
      return;
    }
    setError(result.error);
  }, []);

  useEffect(() => {
    void loadStatus();
    void fetchServerCapabilities().then(({ data }) => {
      setLocalClient(data?.localClient === true);
    });
  }, [loadStatus]);

  const runImport = async (sourceId: string, dryRun: boolean) => {
    setBusy(`${sourceId}:${dryRun ? "preview" : "import"}`);
    const result = await sessionsApi<SessionImportReceipt>(
      "/api/sessions/import",
      {
        method: "POST",
        body: JSON.stringify({ sourceId, dryRun }),
      }
    );
    setBusy(null);
    if (!result.data) {
      setError(result.error);
      setActionErrorCount((count) => count + 1);
      return;
    }
    const receipt = result.data;
    setError(null);
    setReceipts((current) => ({ ...current, [sourceId]: receipt }));
    if (!dryRun) await loadStatus();
  };

  const removeSource = async (sourceId: string) => {
    setBusy(`${sourceId}:remove`);
    const result = await sessionsApi(
      `/api/sessions/sources/${encodeURIComponent(sourceId)}`,
      { method: "DELETE" }
    );
    setBusy(null);
    if (result.error) {
      setError(result.error);
      setActionErrorCount((count) => count + 1);
      return;
    }
    setReceipts((current) => {
      const next = { ...current };
      delete next[sourceId];
      return next;
    });
    await loadStatus();
  };

  const archiveCollections = status?.collections.map((c) => c.name) ?? [];

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl space-y-3">
            <div className="flex items-center gap-2 text-primary">
              <ArchiveIcon aria-hidden="true" className="size-4" />
              <span className="font-medium text-sm tracking-wide uppercase">
                Agent session archive
              </span>
            </div>
            <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">
              Agent sessions
            </h1>
            {status && (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Archive index</span>
                <Badge className="font-mono" variant="secondary">
                  {status.index}
                </Badge>
                <span className="text-muted-foreground">
                  · {status.collections.length} collection
                  {status.collections.length === 1 ? "" : "s"}
                </span>
              </p>
            )}
            <p className="text-muted-foreground text-sm">
              Import is manual. Nothing here watches your agents or imports on
              its own; each import runs only when you press a button.
            </p>
          </div>
          <Button onClick={() => navigate("/")} variant="outline">
            Back to Dashboard
          </Button>
        </header>

        <aside className="flex gap-3 rounded-lg border border-border/60 bg-muted/30 p-4 text-sm">
          <InfoIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-primary"
          />
          <p className="min-w-0">
            This archive index is separate from your curated index. Broad search
            in a curated instance does not include archived sessions unless you
            explicitly register an archive collection in that index. Human turns
            are what you wrote; assistant turns are agent output — suggestions,
            not your decisions.
          </p>
        </aside>

        {error && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent
              className="break-words py-4 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              ref={errorRef}
              role="alert"
              tabIndex={-1}
            >
              {error}
            </CardContent>
          </Card>
        )}

        {loading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading archive status…
          </p>
        )}

        {unbound !== null && (
          <section
            aria-labelledby="sessions-unbound-heading"
            className="space-y-4 rounded-lg border border-dashed border-border/70 p-4 sm:p-6"
          >
            <div className="flex items-center gap-2">
              <MessagesSquareIcon
                aria-hidden="true"
                className="size-5 text-primary"
              />
              <h2
                className="font-semibold text-xl"
                id="sessions-unbound-heading"
              >
                This server is not a session archive
              </h2>
            </div>
            <p className="break-words text-muted-foreground text-sm">
              {unbound}
            </p>
            <p className="text-sm">
              Session archives live in their own config file and named index.
              Create one, then start a server for it:
            </p>
            <CommandLine>{INIT_COMMAND}</CommandLine>
            <CommandLine>{SERVE_COMMAND}</CommandLine>
            {localClient && <InitForm onDone={loadStatus} />}
          </section>
        )}

        {status && (
          <>
            {status.warnings.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-amber-800 text-sm dark:text-amber-200">
                {status.warnings.map((warning) => (
                  <li className="break-words" key={warning}>
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            <SourcesPanel
              archiveCollections={archiveCollections}
              busy={busy}
              localClient={localClient}
              onChanged={loadStatus}
              onImport={(sourceId, dryRun) => void runImport(sourceId, dryRun)}
              onRemove={(sourceId) => void removeSource(sourceId)}
              receipts={receipts}
              sources={status.sources}
            />
            <SessionSearch
              collections={archiveCollections}
              navigate={(to) => navigate(to)}
            />
          </>
        )}
      </main>
    </div>
  );
}
