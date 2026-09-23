import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import { useState } from "react";

import type {
  CompiledContextPreview as Preview,
  CompiledContextCheck as Check,
} from "../../../core/compiled-context";

import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { apiFetch } from "../hooks/use-api";

const MAX_BYTES = 4 * 1024 * 1024;
const byteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

export default function CompiledContext({
  navigate,
}: {
  navigate: (to: string | number) => void;
}) {
  const [capsule, setCapsule] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [tokens, setTokens] = useState("12000");
  const [bytes, setBytes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    setPreview(null);
    setCheck(null);
    setError(null);
  };
  const upload = async (
    file: File | undefined,
    kind: "capsule" | "markdown"
  ) => {
    if (!file) return;
    invalidate();
    if (kind === "capsule") setCapsule("");
    else setMarkdown("");
    if (file.size > MAX_BYTES) {
      setError("Files must be 4 MiB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      if (kind === "capsule") setCapsule(text);
      else setMarkdown(text);
    } catch {
      setError("Could not read this file.");
    } finally {
      setBusy(false);
    }
  };
  const run = async (kind: "preview" | "check") => {
    invalidate();
    setBusy(true);
    try {
      if (byteLength(capsule) > MAX_BYTES || byteLength(markdown) > MAX_BYTES)
        throw new Error("Inputs must be 4 MiB or smaller.");
      const parsed: unknown = JSON.parse(capsule);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Supply a Capsule JSON object.");
      if (kind === "preview") {
        const budgetTokens = Number(tokens);
        const budgetBytes = bytes === "" ? undefined : Number(bytes);
        if (
          !Number.isInteger(budgetTokens) ||
          budgetTokens < 1 ||
          budgetTokens > 1_000_000 ||
          (budgetBytes !== undefined &&
            (!Number.isInteger(budgetBytes) ||
              budgetBytes < 1 ||
              budgetBytes > MAX_BYTES))
        )
          throw new Error(
            "Choose a positive budget: at most 1,000,000 tokens and 4 MiB."
          );
        const result = await apiFetch<Preview>(
          "/api/context/compiled/preview",
          {
            method: "POST",
            body: JSON.stringify({
              capsule: parsed,
              budgetTokens,
              budgetBytes,
            }),
          }
        );
        if (result.error || !result.data)
          throw new Error(result.error ?? "No preview returned.");
        setPreview(result.data);
      } else {
        if (!markdown.trim())
          throw new Error("Supply the compiled Markdown to check.");
        const result = await apiFetch<Check>("/api/context/compiled/check", {
          method: "POST",
          body: JSON.stringify({ capsule: parsed, markdown }),
        });
        if (result.error || !result.data)
          throw new Error(result.error ?? "No check returned.");
        setCheck(result.data);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!preview) return;
    const url = URL.createObjectURL(
      new Blob([preview.markdown], { type: "text/markdown;charset=utf-8" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "project.gno-context.md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <main className="container mx-auto max-w-5xl space-y-6 px-4 py-8">
      <Button onClick={() => navigate("/")} variant="ghost">
        <ArrowLeftIcon className="size-4" /> Dashboard
      </Button>
      <header className="space-y-2">
        <h1 className="font-serif text-3xl">Compiled project context</h1>
        <p className="text-muted-foreground">
          Turn a verified Context Capsule into a compact, cited Markdown file.
          Source passages remain untrusted evidence, not agent instructions.
        </p>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run("preview");
        }}
      >
        <fieldset className="min-w-0 space-y-4" disabled={busy}>
          <legend className="sr-only">Compile a Context Capsule</legend>
          <Card>
            <CardHeader>
              <CardTitle>1. Supply a Capsule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Use a Capsule from this GNO instance. Verification checks
                current sources and access before returning evidence. Inputs are
                limited to 4 MiB each.
              </p>
              <label className="block space-y-2" htmlFor="capsule-file">
                <span>Upload Capsule JSON</span>
                <Input
                  accept=".json,application/json"
                  id="capsule-file"
                  onChange={(event) =>
                    void upload(event.target.files?.[0], "capsule")
                  }
                  type="file"
                />
              </label>
              <label className="block space-y-2" htmlFor="capsule-json">
                <span>Or paste Capsule JSON</span>
                <Textarea
                  className="h-40 min-w-0 field-sizing-fixed font-mono text-xs"
                  id="capsule-json"
                  onChange={(event) => {
                    invalidate();
                    setCapsule(event.target.value);
                  }}
                  spellCheck={false}
                  value={capsule}
                />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2" htmlFor="context-tokens">
                  <span>Token budget</span>
                  <Input
                    id="context-tokens"
                    max={1_000_000}
                    min={1}
                    onChange={(event) => {
                      invalidate();
                      setTokens(event.target.value);
                    }}
                    required
                    type="number"
                    value={tokens}
                  />
                </label>
                <label className="space-y-2" htmlFor="context-bytes">
                  <span>Byte budget (optional)</span>
                  <Input
                    id="context-bytes"
                    max={MAX_BYTES}
                    min={1}
                    onChange={(event) => {
                      invalidate();
                      setBytes(event.target.value);
                    }}
                    type="number"
                    value={bytes}
                  />
                </label>
              </div>
              <Button type="submit">
                {busy ? "Verifying…" : "Preview verified context"}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>2. Check an existing artifact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="block space-y-2" htmlFor="context-file">
                <span>Upload compiled Markdown</span>
                <Input
                  accept=".md,text/markdown"
                  id="context-file"
                  onChange={(event) =>
                    void upload(event.target.files?.[0], "markdown")
                  }
                  type="file"
                />
              </label>
              <label className="block space-y-2" htmlFor="context-markdown">
                <span>Or paste compiled Markdown</span>
                <Textarea
                  className="h-32 min-w-0 field-sizing-fixed font-mono text-xs"
                  id="context-markdown"
                  onChange={(event) => {
                    invalidate();
                    setMarkdown(event.target.value);
                  }}
                  spellCheck={false}
                  value={markdown}
                />
              </label>
              <Button
                onClick={() => void run("check")}
                type="button"
                variant="outline"
              >
                Check freshness
              </Button>
            </CardContent>
          </Card>
        </fieldset>
      </form>
      {error && (
        <p className="break-words text-destructive" role="alert">
          {error}
        </p>
      )}
      {check && (
        <Card>
          <CardHeader>
            <CardTitle>Artifact: {check.status}</CardTitle>
          </CardHeader>
          <CardContent aria-live="polite">
            <ul className="list-inside list-disc">
              {check.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">
              Check is read-only. Conflicts require inspecting manual edits;
              stale evidence requires an explicit local refresh.
            </p>
          </CardContent>
        </Card>
      )}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Verified preview</CardTitle>
          </CardHeader>
          <CardContent className="min-w-0 space-y-4 break-words">
            <p>
              {preview.budget.usedTokens.toLocaleString()} tokens ·{" "}
              {preview.budget.usedBytes.toLocaleString()} bytes ·{" "}
              {preview.budget.estimator}
            </p>
            <p>
              {preview.coverage.complete
                ? "Required facets covered"
                : "Incomplete coverage"}
            </p>
            <p>
              Covered facets:{" "}
              {preview.coverage.coveredFacets.join(", ") || "None"}
            </p>
            <p>
              Unresolved facets:{" "}
              {preview.coverage.unresolvedFacets.join(", ") || "None"}
            </p>
            <details>
              <summary className="cursor-pointer">
                Evidence and verification
              </summary>
              <div className="space-y-2 break-all font-mono text-xs">
                <p>Output digest: {preview.digest}</p>
                <p>Verification digest: {preview.verificationDigest}</p>
                <p>Evidence: {preview.evidenceIds.join(", ") || "None"}</p>
                <ul>
                  {preview.omissions.map((item) => (
                    <li key={item.evidenceId}>
                      {item.evidenceId}: {item.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
            <pre
              aria-label="Compiled Markdown preview"
              className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-4 font-mono text-xs"
            >
              {preview.markdown}
            </pre>
            <Button onClick={download}>
              <DownloadIcon className="size-4" /> Download Markdown
            </Button>
            <p className="text-sm text-muted-foreground">
              Download contains exactly the preview bytes. It does not create a
              local refresh sidecar or update your agent instructions.
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Refresh local files explicitly</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            For managed refresh, first compile locally with an explicit Capsule
            file. Run gno update after source edits: checks use indexed state.
            Choose a fresh Capsule output filename for each stale refresh.
            Refresh preserves hand edits by reporting a conflict. Nothing
            refreshes in the background.
          </p>
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/30 p-4 text-xs">
            {
              "gno context compiled compile --capsule capsule.json --budget 12000 --output project.gno-context.md\ngno context compiled check project.gno-context.md\ngno context compiled refresh project.gno-context.md --capsule-output project.gno-context.capsule.json"
            }
          </pre>
        </CardContent>
      </Card>
    </main>
  );
}
