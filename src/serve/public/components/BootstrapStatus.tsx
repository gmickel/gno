import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  HardDriveIcon,
  PackageIcon,
  ServerCogIcon,
} from "lucide-react";

import type { AppStatusResponse } from "../../status-model";

import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";

interface BootstrapStatusProps {
  bootstrap: AppStatusResponse["bootstrap"];
  activation: AppStatusResponse["activation"];
  onDownloadModels: () => void;
}

function formatRole(
  role: AppStatusResponse["bootstrap"]["models"]["entries"][number]["role"]
): string {
  switch (role) {
    case "gen":
      return "Answer";
    case "expand":
      return "Expand";
    case "embed":
      return "Embed";
    case "rerank":
      return "Rerank";
  }
}

export function BootstrapStatus({
  activation,
  bootstrap,
  onDownloadModels,
}: BootstrapStatusProps) {
  const missingModels =
    bootstrap.models.totalCount - bootstrap.models.cachedCount;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <PackageIcon className="size-4 text-primary" />
            <h2 className="font-semibold text-2xl">Bootstrap & Storage</h2>
          </div>
          <p className="max-w-3xl text-muted-foreground">
            Runtime, download policy, and cache state for the current beta
            install.
          </p>
        </div>
        {missingModels > 0 && !bootstrap.models.downloading && (
          <Button onClick={onDownloadModels} size="sm">
            <DownloadIcon className="mr-2 size-4" />
            Download missing models
          </Button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="border-border/60 bg-card/70">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ServerCogIcon className="size-4 text-primary" />
              <CardTitle className="text-base">Runtime</CardTitle>
            </div>
            <CardDescription>{bootstrap.runtime.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{bootstrap.runtime.detail}</p>
            <p className="text-muted-foreground">
              Required: {bootstrap.runtime.requiredVersion}
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/70">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <HardDriveIcon className="size-4 text-primary" />
              <CardTitle className="text-base">Cache</CardTitle>
            </div>
            <CardDescription>{bootstrap.policy.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Total cache: {bootstrap.cache.totalSizeLabel}</p>
            <p className="font-mono text-muted-foreground text-xs">
              {bootstrap.cache.path}
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/70">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <PackageIcon className="size-4 text-primary" />
              <CardTitle className="text-base">Active preset</CardTitle>
            </div>
            <CardDescription>{bootstrap.models.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              {bootstrap.models.activePresetName}
              {bootstrap.models.estimatedFootprint
                ? ` (${bootstrap.models.estimatedFootprint})`
                : ""}
            </p>
            <div className="space-y-2">
              {bootstrap.models.entries.map((entry) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"
                  key={`${entry.role}-${entry.uri}`}
                >
                  <span>{formatRole(entry.role)}</span>
                  <span className="text-muted-foreground text-xs">
                    {entry.statusLabel}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/70">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              {activation.healthy ? (
                <CheckCircle2Icon className="size-4 text-emerald-500" />
              ) : (
                <AlertCircleIcon className="size-4 text-destructive" />
              )}
              <CardTitle className="text-base">Retrieval proof</CardTitle>
            </div>
            <CardDescription>
              {activation.healthy
                ? "Lexical retrieval proven"
                : activation.usable
                  ? `Search usable in ${activation.collections.filter(({ ready }) => ready).length}/${activation.collections.length} folders`
                  : "Retrieval proof failed"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {activation.collections.length === 0 ? (
              <p className="text-muted-foreground">
                Add and index a text folder to prove retrieval.
              </p>
            ) : (
              activation.collections.map((collection) => (
                <div
                  className="rounded-lg border border-border/50 px-3 py-2"
                  key={collection.collection}
                >
                  <p className="font-medium">{collection.collection}</p>
                  <p className="text-muted-foreground text-xs">
                    {collection.ready
                      ? `Lexical passed; semantic ${collection.semanticAvailability.code}`
                      : `${collection.remediation?.stage ?? "index"}/${collection.remediation?.code ?? "index_query_failed"}`}
                  </p>
                  {collection.remediation && (
                    <p className="mt-1 font-mono text-muted-foreground text-xs">
                      {collection.remediation.command}
                    </p>
                  )}
                </div>
              ))
            )}
            {activation.connectors.length > 0 && (
              <div className="space-y-2 border-border/50 border-t pt-3">
                <p className="font-medium text-xs uppercase tracking-wide">
                  Connector proof
                </p>
                {activation.connectors.slice(0, 8).map((connector) => (
                  <div
                    className="text-muted-foreground text-xs"
                    key={`${connector.collection}-${connector.target}`}
                  >
                    <span className="font-medium text-foreground">
                      {connector.target}
                    </span>{" "}
                    · {connector.collection} · {connector.status}
                    {connector.code ? `/${connector.code}` : ""}
                  </div>
                ))}
                {activation.connectorProjection.total > 8 && (
                  <p className="text-muted-foreground text-xs">
                    +{activation.connectorProjection.total - 8} more
                    target/collection checks
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
