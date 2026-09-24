import { Loader2Icon, SearchIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";

import {
  SESSION_HARNESS_LABELS,
  SESSION_HARNESSES,
  type SessionHarness,
} from "../../../../sessions/types";
import { apiFetch } from "../../hooks/use-api";
import { buildDocDeepLink } from "../../lib/deep-links";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { renderSessionSnippet } from "./snippet";

interface SessionSearchResult {
  docid: string;
  uri: string;
  title?: string;
  snippet: string;
  categories?: string[];
  record?: {
    author?: string;
    categories?: string[];
    dateFields?: Record<string, string>;
  };
}

interface SearchResponse {
  results: SessionSearchResult[];
}

interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}

type Role = "human" | "assistant";

const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const tagValue = (tags: readonly string[], prefix: string): string | null =>
  tags.find((tag) => tag.startsWith(`${prefix}/`))?.slice(prefix.length + 1) ??
  null;

function resultRole(result: SessionSearchResult, tags: string[]): Role | null {
  const author = result.record?.author?.toLowerCase();
  if (author === "human" || author === "assistant") return author;
  const role = tagValue(tags, "role");
  if (role === "human" || role === "assistant") return role;
  const title = result.title ?? "";
  if (title.startsWith("Human")) return "human";
  if (title.startsWith("Assistant")) return "assistant";
  return null;
}

function AuthorBadge({ role }: { role: Role | null }) {
  if (role === "human") {
    return (
      <Badge className="bg-sky-600 text-white dark:bg-sky-500">Human</Badge>
    );
  }
  if (role === "assistant") {
    return (
      <Badge className="whitespace-normal text-left" variant="outline">
        Assistant — suggestion, not a user decision
      </Badge>
    );
  }
  return <Badge variant="outline">Author unknown</Badge>;
}

function formatRecorded(iso: string | undefined): string {
  if (!iso) return "time unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

interface SessionSearchProps {
  collections: string[];
  navigate: (to: string) => void;
}

export function SessionSearch({ collections, navigate }: SessionSearchProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [harness, setHarness] = useState<"" | SessionHarness>("");
  const [project, setProject] = useState("");
  const [role, setRole] = useState<"" | Role>("");
  const [collection, setCollection] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [results, setResults] = useState<SessionSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void apiFetch<TagsResponse>("/api/tags?prefix=project").then(({ data }) => {
      setProjects(
        (data?.tags ?? [])
          .map((entry) => entry.tag)
          .filter((tag) => tag.startsWith("project/"))
          .map((tag) => tag.slice("project/".length))
          .sort()
      );
    });
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    const tagsAll = [
      "session",
      harness ? `harness/${harness}` : null,
      project ? `project/${project}` : null,
      role ? `role/${role}` : null,
    ].filter((tag): tag is string => tag !== null);
    setLoading(true);
    const { data, error: err } = await apiFetch<SearchResponse>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: trimmed,
        limit: 20,
        tagsAll: tagsAll.join(","),
        ...(collection ? { collection } : {}),
      }),
    });
    setLoading(false);
    setError(err);
    setResults(data?.results ?? null);
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="min-w-0 space-y-4">
      <h2 className="font-semibold text-xl" id={`${id}-heading`}>
        Search sessions
      </h2>
      <form
        className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => void submit(event)}
        role="search"
      >
        <div className="grid min-w-0 gap-1 text-sm sm:col-span-2 lg:col-span-4">
          <label htmlFor={`${id}-query`}>Session search query</label>
          <div className="flex min-w-0 gap-2">
            <Input
              id={`${id}-query`}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="What was decided about…"
              type="search"
              value={query}
            />
            <Button disabled={loading || !query.trim()} type="submit">
              {loading ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <SearchIcon />
              )}
              Search
            </Button>
          </div>
        </div>
        <label className="grid gap-1 text-sm" htmlFor={`${id}-harness`}>
          Harness
          <select
            className={SELECT_CLASS}
            id={`${id}-harness`}
            onChange={(event) =>
              setHarness(event.currentTarget.value as "" | SessionHarness)
            }
            value={harness}
          >
            <option value="">All harnesses</option>
            {SESSION_HARNESSES.map((value) => (
              <option key={value} value={value}>
                {SESSION_HARNESS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${id}-project`}>
          Project
          <select
            className={SELECT_CLASS}
            id={`${id}-project`}
            onChange={(event) => setProject(event.currentTarget.value)}
            value={project}
          >
            <option value="">All projects</option>
            {projects.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${id}-role`}>
          Speaker
          <select
            className={SELECT_CLASS}
            id={`${id}-role`}
            onChange={(event) =>
              setRole(event.currentTarget.value as "" | Role)
            }
            value={role}
          >
            <option value="">Human and assistant</option>
            <option value="human">Human only</option>
            <option value="assistant">Assistant only</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm" htmlFor={`${id}-collection`}>
          Collection
          <select
            className={SELECT_CLASS}
            id={`${id}-collection`}
            onChange={(event) => setCollection(event.currentTarget.value)}
            value={collection}
          >
            <option value="">All archive collections</option>
            {collections.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </form>

      {error && (
        <p className="break-words text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {results && results.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No archived turns matched.
        </p>
      )}
      {results && results.length > 0 && (
        <ol aria-label="Session search results" className="space-y-3">
          {results.map((result) => {
            const tags = result.categories ?? result.record?.categories ?? [];
            const resultHarness = tagValue(tags, "harness");
            const resultProject = tagValue(tags, "project");
            const href = buildDocDeepLink({ uri: result.uri });
            return (
              <li
                className="min-w-0 space-y-2 rounded-lg border border-border/60 p-3"
                key={result.docid}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <AuthorBadge role={resultRole(result, tags)} />
                  <Badge variant="secondary">
                    {resultHarness
                      ? (SESSION_HARNESS_LABELS[
                          resultHarness as SessionHarness
                        ] ?? resultHarness)
                      : "harness unknown"}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    project {resultProject ?? "none"} ·{" "}
                    {formatRecorded(result.record?.dateFields?.recorded)}
                  </span>
                </div>
                <a
                  className="block break-words font-medium text-primary underline-offset-2 hover:underline"
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(href);
                  }}
                >
                  {result.title || result.uri}
                </a>
                <p className="line-clamp-3 break-words text-muted-foreground text-sm">
                  {renderSessionSnippet(result.snippet)}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
