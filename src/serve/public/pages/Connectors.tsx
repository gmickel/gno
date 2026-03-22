import {
  BotIcon,
  CheckCircle2Icon,
  CpuIcon,
  Loader2Icon,
  PlugZapIcon,
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
}

export default function Connectors({ navigate }: PageProps) {
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  const loadConnectors = useCallback(async () => {
    const { data, error: err } =
      await apiFetch<ConnectorsResponse>("/api/connectors");
    if (err) {
      setError(err);
      return;
    }

    setConnectors(data?.connectors ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  const handleInstall = async (connectorId: string) => {
    setInstallingId(connectorId);
    const { error: err } = await apiFetch("/api/connectors/install", {
      method: "POST",
      body: JSON.stringify({ connectorId }),
    });
    setInstallingId(null);

    if (err) {
      setError(err);
      return;
    }

    await loadConnectors();
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
          <Button onClick={() => navigate("/")} variant="outline">
            Back to Dashboard
          </Button>
        </div>

        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="py-4 text-destructive">{error}</CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {connectors.map((connector) => (
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
                  <div className="mb-1 font-medium">{connector.mode.label}</div>
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
                  <p className="text-destructive text-sm">{connector.error}</p>
                )}
                <p className="text-muted-foreground">{connector.nextAction}</p>
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
          ))}
        </div>
      </main>
    </div>
  );
}
