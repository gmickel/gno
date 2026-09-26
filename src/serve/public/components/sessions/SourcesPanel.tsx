import {
  DownloadIcon,
  EyeIcon,
  Loader2Icon,
  RadarIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type {
  SessionDiscoveryCandidate,
  SessionImportReceipt,
  SessionsDiscovery,
  SessionSourceStatus,
} from "./api";

import { SESSION_HARNESS_LABELS } from "../../../../sessions/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { sessionsApi } from "./api";
import { ImportReceipt } from "./ImportReceipt";

const SOURCE_ID_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}";
/** Select value for "type a collection name that does not exist yet". */
const NEW_COLLECTION = "__new__";
const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Focus `ref` whenever `trigger` changes to a new truthy value after mount.
 * Buttons disable while their request runs, which drops keyboard focus to
 * <body>; this hands it to the region that reports the outcome instead.
 */
function useFocusOnChange<T>(
  trigger: T,
  ref: { current: HTMLElement | null }
): void {
  const previous = useRef(trigger);
  useEffect(() => {
    if (trigger && trigger !== previous.current) ref.current?.focus();
    previous.current = trigger;
  }, [trigger, ref]);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse "prefix=collection" lines into project mappings. */
export function parseProjectLines(
  text: string
): Array<{ prefix: string; collection: string }> | string {
  const mappings: Array<{ prefix: string; collection: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const split = line.lastIndexOf("=");
    const prefix = split > 0 ? line.slice(0, split).trim() : "";
    const collection = split > 0 ? line.slice(split + 1).trim() : "";
    if (!(prefix && collection)) {
      return `Project mapping "${line}" must look like /absolute/prefix=collection`;
    }
    mappings.push({ prefix, collection });
  }
  return mappings;
}

interface SourceRowProps {
  source: SessionSourceStatus;
  localClient: boolean;
  busy: string | null;
  receipt: SessionImportReceipt | undefined;
  onImport: (sourceId: string, dryRun: boolean) => void;
  onRemove: (sourceId: string) => void;
}

function SourceRow({
  source,
  localClient,
  busy,
  receipt,
  onImport,
  onRemove,
}: SourceRowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const receiptRef = useRef<HTMLElement>(null);
  useFocusOnChange(receipt, receiptRef);
  const running = busy?.startsWith(`${source.id}:`) ?? false;
  const { units } = source;
  return (
    <li className="min-w-0 space-y-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all font-mono font-semibold">{source.id}</h3>
            <Badge variant="secondary">
              {SESSION_HARNESS_LABELS[source.harness]}
            </Badge>
            {source.available ? (
              <Badge variant="outline">available</Badge>
            ) : (
              <Badge variant="destructive">unavailable — archive kept</Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            → collection{" "}
            <span className="font-mono text-foreground">
              {source.collection}
            </span>{" "}
            · last import {formatWhen(source.lastImportAt)}
          </p>
          <p className="text-muted-foreground text-xs">
            Units: {units.total} total · {units.complete} complete ·{" "}
            <span
              className={
                units.incomplete > 0 ? "text-amber-700 dark:text-amber-300" : ""
              }
            >
              {units.incomplete} incomplete
            </span>{" "}
            ·{" "}
            <span className={units.failed > 0 ? "text-destructive" : ""}>
              {units.failed} failed
            </span>{" "}
            · {units.pending} pending · {source.archivedThreads} archived
            threads
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            aria-label={`Preview import of ${source.id} (dry run)`}
            disabled={busy !== null || !source.available}
            onClick={() => onImport(source.id, true)}
            size="sm"
            variant="outline"
          >
            {busy === `${source.id}:preview` ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <EyeIcon />
            )}
            Preview (dry run)
          </Button>
          <Button
            aria-label={`Import ${source.id}`}
            disabled={busy !== null || !source.available}
            onClick={() => onImport(source.id, false)}
            size="sm"
          >
            {busy === `${source.id}:import` ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <DownloadIcon />
            )}
            Import
          </Button>
          {localClient &&
            (confirmRemove ? (
              <>
                <Button
                  disabled={running}
                  onClick={() => onRemove(source.id)}
                  size="sm"
                  variant="destructive"
                >
                  Confirm remove
                </Button>
                <Button
                  onClick={() => setConfirmRemove(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                aria-label={`Remove source ${source.id}`}
                disabled={busy !== null}
                onClick={() => setConfirmRemove(true)}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon />
                Remove
              </Button>
            ))}
        </div>
      </div>
      {confirmRemove && (
        <p className="text-muted-foreground text-xs">
          Removing unregisters the source. Its archived sessions stay in the
          archive and index.
        </p>
      )}
      {receipt && <ImportReceipt receipt={receipt} ref={receiptRef} />}
    </li>
  );
}

interface RegisterFormProps {
  candidate: SessionDiscoveryCandidate;
  archiveCollections: string[];
  onRegistered: (sourceId: string, collection: string) => Promise<void>;
}

function RegisterForm({
  candidate,
  archiveCollections,
  onRegistered,
}: RegisterFormProps) {
  const formId = useId();
  const [id, setId] = useState(`${candidate.harness}-main`);
  // No default: the destination collection is a privacy boundary, so the
  // user must pick it explicitly.
  const [collectionChoice, setCollectionChoice] = useState("");
  const [newCollection, setNewCollection] = useState("");
  const [projects, setProjects] = useState("");
  const [error, setError] = useState<{ text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useFocusOnChange(error, errorRef);

  const creatingCollection = collectionChoice === NEW_COLLECTION;
  const collection = creatingCollection
    ? newCollection.trim()
    : collectionChoice;
  const hintId = `${formId}-collection-hint`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!collection) {
      setError({ text: "Choose a destination archive collection." });
      return;
    }
    const mappings = parseProjectLines(projects);
    if (typeof mappings === "string") {
      setError({ text: mappings });
      return;
    }
    setSaving(true);
    const result = await sessionsApi("/api/sessions/sources", {
      method: "POST",
      body: JSON.stringify({
        id: id.trim(),
        harness: candidate.harness,
        path: candidate.path,
        collection,
        ...(mappings.length > 0 ? { projects: mappings } : {}),
      }),
    });
    setSaving(false);
    if (result.error) {
      setError({ text: result.error });
      return;
    }
    setError(null);
    await onRegistered(id.trim(), collection);
  };

  return (
    <form
      aria-label={`Register ${SESSION_HARNESS_LABELS[candidate.harness]} source`}
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => void submit(event)}
    >
      <label className="grid gap-1 text-sm" htmlFor={`${formId}-id`}>
        Source ID
        <Input
          id={`${formId}-id`}
          onChange={(event) => setId(event.currentTarget.value)}
          pattern={SOURCE_ID_PATTERN}
          required
          value={id}
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor={`${formId}-collection`}>
        Destination archive collection
        <select
          aria-describedby={collection ? undefined : hintId}
          className={SELECT_CLASS}
          id={`${formId}-collection`}
          onChange={(event) => setCollectionChoice(event.currentTarget.value)}
          required
          value={collectionChoice}
        >
          <option disabled value="">
            Choose a collection…
          </option>
          {archiveCollections.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={NEW_COLLECTION}>New collection…</option>
        </select>
      </label>
      {creatingCollection && (
        <label
          className="grid gap-1 text-sm sm:col-start-2"
          htmlFor={`${formId}-new-collection`}
        >
          New collection name
          <Input
            id={`${formId}-new-collection`}
            onChange={(event) => setNewCollection(event.currentTarget.value)}
            pattern={SOURCE_ID_PATTERN}
            required
            value={newCollection}
          />
        </label>
      )}
      <label
        className="grid gap-1 text-sm sm:col-span-2"
        htmlFor={`${formId}-projects`}
      >
        Project mappings (optional, one per line: /absolute/prefix=collection)
        <textarea
          className="min-h-16 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          id={`${formId}-projects`}
          onChange={(event) => setProjects(event.currentTarget.value)}
          value={projects}
        />
      </label>
      {error && (
        <p
          className={`break-words text-destructive text-sm sm:col-span-2 ${FOCUS_RING}`}
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {error.text}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button
          aria-describedby={collection ? undefined : hintId}
          disabled={saving || !collection}
          size="sm"
          type="submit"
        >
          {saving && <Loader2Icon className="animate-spin" />}
          Register source
        </Button>
        <span className="ml-2 text-muted-foreground text-xs">
          Registering imports nothing.
        </span>
        {!collection && (
          <p className="mt-1 text-muted-foreground text-xs" id={hintId}>
            Choose a destination collection to register this source. Its
            sessions become searchable only in that collection.
          </p>
        )}
      </div>
    </form>
  );
}

interface SourcesPanelProps {
  sources: SessionSourceStatus[];
  archiveCollections: string[];
  localClient: boolean;
  busy: string | null;
  receipts: Record<string, SessionImportReceipt>;
  onImport: (sourceId: string, dryRun: boolean) => void;
  onRemove: (sourceId: string) => void;
  onChanged: () => Promise<void>;
}

export function SourcesPanel({
  sources,
  archiveCollections,
  localClient,
  busy,
  receipts,
  onImport,
  onRemove,
  onChanged,
}: SourcesPanelProps) {
  const [discovery, setDiscovery] = useState<SessionsDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useFocusOnChange(notice, noticeRef);
  // Bumped when the Discover button's run finishes: focus moves to its outcome.
  const [discoveredCount, setDiscoveredCount] = useState(0);
  const discoveryRef = useRef<HTMLDivElement>(null);
  useFocusOnChange(discoveredCount, discoveryRef);

  const discover = async (focusOutcome = false) => {
    setDiscovering(true);
    const result = await sessionsApi<SessionsDiscovery>(
      "/api/sessions/discover"
    );
    setDiscovering(false);
    setDiscoverError(result.error);
    setDiscovery(result.data);
    if (focusOutcome) setDiscoveredCount((count) => count + 1);
  };

  const registered = async (sourceId: string, collection: string) => {
    setNotice({
      text: `Registered source ${sourceId} → collection ${collection}. Nothing was imported yet.`,
    });
    await onChanged();
    await discover();
  };

  return (
    <section
      aria-labelledby="sessions-sources-heading"
      className="min-w-0 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-xl" id="sessions-sources-heading">
          Sources
        </h2>
        {localClient && (
          <Button
            disabled={discovering}
            onClick={() => void discover(true)}
            size="sm"
            variant="outline"
          >
            {discovering ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RadarIcon />
            )}
            Discover local sources
          </Button>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No sources registered yet.{" "}
          {localClient
            ? "Discover local sources and register the ones you permit."
            : "Sources can only be registered from a browser on this machine."}
        </p>
      ) : (
        <ul className="space-y-3">
          {sources.map((source) => (
            <SourceRow
              busy={busy}
              key={source.id}
              localClient={localClient}
              onImport={onImport}
              onRemove={onRemove}
              receipt={receipts[source.id]}
              source={source}
            />
          ))}
        </ul>
      )}

      {notice && (
        <p
          className={`break-words rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-700 text-sm dark:text-emerald-300 ${FOCUS_RING}`}
          ref={noticeRef}
          role="status"
          tabIndex={-1}
        >
          {notice.text}
        </p>
      )}

      {(discoverError || discovery) && (
        <div
          aria-label="Discovery results"
          className={`space-y-3 ${FOCUS_RING}`}
          ref={discoveryRef}
          role="region"
          tabIndex={-1}
        >
          {discoverError && (
            <p className="break-words text-destructive text-sm" role="alert">
              {discoverError}
            </p>
          )}
          {discovery && (
            <div className="space-y-3 rounded-lg border border-dashed border-border/70 p-4">
              <h3 className="font-medium">Discovered on this machine</h3>
              <p className="text-muted-foreground text-xs">
                Preview only: discovery reads nothing into the archive. Register
                a source to permit manual imports from it.
              </p>
              {discovery.candidates.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  No supported session stores were found.
                </p>
              )}
              <ul className="space-y-4">
                {discovery.candidates.map((candidate) => (
                  <li
                    className="min-w-0 space-y-2"
                    key={`${candidate.harness}:${candidate.path}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {SESSION_HARNESS_LABELS[candidate.harness]}
                      </Badge>
                      <span className="min-w-0 break-all font-mono text-xs">
                        {candidate.path}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {candidate.units}
                      {candidate.truncated ? "+" : ""} units ·{" "}
                      {formatBytes(candidate.bytes)}
                      {candidate.formatVersions.length > 0 &&
                        ` · format ${candidate.formatVersions.join(", ")}`}
                    </p>
                    {candidate.registeredAs ? (
                      <p className="text-sm">
                        Registered as{" "}
                        <span className="font-mono">
                          {candidate.registeredAs}
                        </span>
                      </p>
                    ) : (
                      <RegisterForm
                        candidate={candidate}
                        archiveCollections={archiveCollections}
                        onRegistered={registered}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {discovery.warnings.map((warning) => (
                <p
                  className="text-amber-800 text-xs dark:text-amber-200"
                  key={warning}
                >
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
