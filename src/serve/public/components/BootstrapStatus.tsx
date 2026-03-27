import {
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

      <div className="grid gap-4 xl:grid-cols-3">
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
      </div>
    </section>
  );
}
