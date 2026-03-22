import {
  AlertCircleIcon,
  CheckCircle2Icon,
  HardDriveIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";

import type {
  AppStatusResponse,
  HealthActionKind,
  HealthCheck,
} from "../../status-model";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";

interface HealthCenterProps {
  health: AppStatusResponse["health"];
  onAction: (action: HealthActionKind) => void;
  busyAction?: HealthActionKind | null;
}

function getStatusIcon(status: HealthCheck["status"]) {
  switch (status) {
    case "ok":
      return <CheckCircle2Icon className="size-4 text-green-500" />;
    case "warn":
      return <AlertCircleIcon className="size-4 text-amber-500" />;
    case "error":
      return <AlertCircleIcon className="size-4 text-destructive" />;
  }
}

function getStatusLabel(status: HealthCheck["status"]): string {
  switch (status) {
    case "ok":
      return "Ready";
    case "warn":
      return "Needs attention";
    case "error":
      return "Blocked";
  }
}

export function HealthCenter({
  health,
  onAction,
  busyAction,
}: HealthCenterProps) {
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <HardDriveIcon className="size-4 text-primary" />
            <h2 className="font-semibold text-2xl">Health Center</h2>
          </div>
          <p className="max-w-3xl text-muted-foreground">{health.summary}</p>
        </div>
        <Badge
          className="border-primary/20 bg-primary/10 text-primary"
          variant="outline"
        >
          {health.state === "healthy"
            ? "Ready"
            : health.state === "setup-required"
              ? "First run"
              : "Needs attention"}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {health.checks.map((check) => {
          const isBusy = busyAction === check.actionKind;

          return (
            <Card
              className="border-border/60 bg-card/70 backdrop-blur-sm"
              key={check.id}
            >
              <CardHeader className="space-y-3 pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(check.status)}
                    <CardTitle className="text-base">{check.title}</CardTitle>
                  </div>
                  <Badge variant="secondary">
                    {getStatusLabel(check.status)}
                  </Badge>
                </div>
                <CardDescription className="text-sm text-foreground/85">
                  {check.summary}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground text-sm">{check.detail}</p>
                {check.actionKind && check.actionLabel && (
                  <Button
                    className="w-full"
                    disabled={isBusy}
                    onClick={() => onAction(check.actionKind!)}
                    size="sm"
                    variant={check.status === "ok" ? "outline" : "default"}
                  >
                    {isBusy ? (
                      <Loader2Icon className="mr-2 size-4 animate-spin" />
                    ) : check.status === "ok" ? (
                      <SparklesIcon className="mr-2 size-4" />
                    ) : null}
                    {check.actionLabel}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
