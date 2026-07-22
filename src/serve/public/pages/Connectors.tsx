import {
  AlertCircleIcon,
  BotIcon,
  CheckCircle2Icon,
  CpuIcon,
  Loader2Icon,
  PlugZapIcon,
  SearchCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { apiFetch } from "../hooks/use-api";

interface PageProps {
  navigate: (to: string | number) => void;
}

interface ConnectorStatus {
  id: string;
  appName: string;
  installKind: "skill" | "mcp";
  target: string;
  scope: "user" | "project";
  installed: boolean;
  path: string;
  summary: string;
  nextAction: string;
  mode: {
    label: string;
    detail: string;
  };
  error?: string;
}

interface ConnectorsResponse {
  connectors: ConnectorStatus[];
  collections: string[];
}

interface ConnectorVerificationResponse {
  verification: {
    collection: string;
    lexicalReady: boolean;
    connectorReady: boolean;
    generatedAt: string;
    stages: {
      connector: {
        status: "passed" | "pending" | "failed" | "skipped";
        code?: string;
      };
    };
  };
  remediation: string | null;
}

export default function Connectors({ navigate }: PageProps) {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [selectedCollection, setSelectedCollection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verificationById, setVerificationById] = useState<
    Record<string, ConnectorVerificationResponse>
  >({});

  const loadConnectors = useCallback(async () => {
    const { data, error: err } =
      await apiFetch<ConnectorsResponse>("/api/connectors");
    if (err) {
      setError(err);
      return;
    }

    setConnectors(data?.connectors ?? []);
    const nextCollections = data?.collections ?? [];
    setCollections(nextCollections);
    setSelectedCollection((current) =>
      nextCollections.includes(current) ? current : (nextCollections[0] ?? "")
    );
    setError(null);
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  const handleInstall = async (connectorId: string) => {
    const connector = connectors.find((entry) => entry.id === connectorId);
    setInstallingId(connectorId);
    const { error: err } = await apiFetch("/api/connectors/install", {
      method: "POST",
      body: JSON.stringify({
        connectorId,
        reinstall: connector?.installed ?? false,
      }),
    });
    setInstallingId(null);

    if (err) {
      setError(err);
      return;
    }

    await loadConnectors();
  };

  const handleVerify = async (connectorId: string) => {
    if (!selectedCollection) {
      setError("Add and index a collection before verifying retrieval.");
      return;
    }

    setVerifyingId(connectorId);
    setError(null);
    const { data, error: err } = await apiFetch<ConnectorVerificationResponse>(
      "/api/connectors/verify",
      {
        method: "POST",
        body: JSON.stringify({
          connectorId,
          collection: selectedCollection,
        }),
      }
    );
    setVerifyingId(null);

    if (err || !data) {
      setError(err ?? "Connector verification could not be completed.");
      return;
    }

    setVerificationById((current) => ({
      ...current,
      [connectorId]: data,
    }));
  };

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-6xl p-8">
        <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 text-primary">
              <PlugZapIcon className="size-4" />
              <span className="font-medium text-sm tracking-wide uppercase">
                Agent Connectors
              </span>
            </div>
            <h1 className="font-semibold text-3xl tracking-tight">
              Install GNO into your coding agents without editing config files
            </h1>
            <p className="text-muted-foreground">
              These actions reuse the existing CLI installers. Read/search
              access is the default path. Write-capable MCP stays an advanced
              opt-in instead of something the app quietly enables for you.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <Button onClick={() => navigate("/")} variant="outline">
              Back to Dashboard
            </Button>
            {collections.length > 0 && (
              <label className="flex items-center gap-2 font-mono text-muted-foreground text-xs">
                Proof collection
                <select
                  className="cursor-pointer rounded border border-border/60 bg-background px-2 py-1.5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  onChange={(event) =>
                    setSelectedCollection(event.currentTarget.value)
                  }
                  value={selectedCollection}
                >
                  {collections.map((collection) => (
                    <option key={collection} value={collection}>
                      {collection}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>

        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="py-4 text-destructive">{error}</CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connectors.map((connector) => {
            const verification = verificationById[connector.id];
            return (
              <Card className="border-border/60 bg-card/70" key={connector.id}>
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <BotIcon className="size-4 text-primary" />
                      <CardTitle className="text-base">
                        {connector.appName}
                      </CardTitle>
                    </div>
                    {connector.installed ? (
                      <CheckCircle2Icon className="size-4 text-green-500" />
                    ) : (
                      <CpuIcon className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <CardDescription>{connector.summary}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="rounded-lg border border-border/50 bg-background/70 p-3">
                    <div className="mb-1 font-medium">
                      {connector.mode.label}
                    </div>
                    <p className="text-muted-foreground">
                      {connector.mode.detail}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div>
                      <span className="font-medium">Install type:</span>{" "}
                      {connector.installKind.toUpperCase()}
                    </div>
                    <div>
                      <span className="font-medium">Scope:</span>{" "}
                      {connector.scope}
                    </div>
                    <div className="font-mono text-muted-foreground text-xs">
                      {connector.path}
                    </div>
                  </div>
                  {connector.error && (
                    <p className="text-destructive text-sm">
                      {connector.error}
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    {connector.nextAction}
                  </p>
                  {connector.installed && connector.installKind === "skill" && (
                    <div className="rounded border border-secondary/30 bg-secondary/10 p-3">
                      <div className="flex items-center gap-2 font-medium text-secondary text-xs">
                        <AlertCircleIcon className="size-3.5" />
                        Runtime verification unavailable
                      </div>
                      <p className="mt-1 text-muted-foreground text-xs">
                        target_runtime_unverifiable — this client exposes no
                        safe read-only runtime hook. The skill file is
                        installed, but GNO cannot claim the agent used it.
                      </p>
                    </div>
                  )}
                  {connector.installed && connector.installKind === "mcp" && (
                    <div className="space-y-3 border-border/50 border-t pt-4">
                      <div className="flex items-start gap-2">
                        <SearchCheckIcon className="mt-0.5 size-4 text-primary" />
                        <div>
                          <p className="font-medium text-sm">Retrieval proof</p>
                          <p className="text-muted-foreground text-xs">
                            Starts this configured MCP once and checks a real,
                            collection-scoped result. Runs only when requested.
                          </p>
                        </div>
                      </div>
                      <Button
                        className="w-full"
                        disabled={!selectedCollection || verifyingId !== null}
                        onClick={() => void handleVerify(connector.id)}
                        size="sm"
                        variant="secondary"
                      >
                        {verifyingId === connector.id ? (
                          <Loader2Icon className="mr-2 size-4 animate-spin" />
                        ) : (
                          <SearchCheckIcon className="mr-2 size-4" />
                        )}
                        Verify retrieval
                      </Button>
                      {collections.length === 0 && (
                        <p className="text-muted-foreground text-xs">
                          Add and index a collection before verifying retrieval.
                        </p>
                      )}
                      {verification && (
                        <div
                          aria-live="polite"
                          className={
                            verification.verification.stages.connector
                              .status === "passed"
                              ? "rounded border border-primary/30 bg-primary/10 p-3 text-xs"
                              : "rounded border border-secondary/30 bg-secondary/10 p-3 text-xs"
                          }
                        >
                          <p className="font-mono text-foreground uppercase tracking-wide">
                            {verification.verification.stages.connector.status}
                            {verification.verification.stages.connector.code
                              ? ` / ${verification.verification.stages.connector.code}`
                              : ""}
                          </p>
                          <p className="mt-1 text-muted-foreground">
                            Collection: {verification.verification.collection}
                          </p>
                          <p className="mt-2 text-foreground">
                            {verification.remediation ??
                              "Retrieval returned the expected indexed source. No action needed."}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  <Button
                    className="w-full"
                    onClick={() => void handleInstall(connector.id)}
                    size="sm"
                    variant={connector.installed ? "outline" : "default"}
                  >
                    {installingId === connector.id ? (
                      <Loader2Icon className="mr-2 size-4 animate-spin" />
                    ) : null}
                    {connector.installed ? "Reinstall" : "Install"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}
