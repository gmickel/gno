import {
  CheckCircle2Icon,
  ChevronRightIcon,
  FolderPlusIcon,
  SparklesIcon,
} from "lucide-react";

import type { AppStatusResponse } from "../../status-model";

import { AIModelSelector } from "./AIModelSelector";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";

interface FirstRunWizardProps {
  onboarding: AppStatusResponse["onboarding"];
  onAddCollection: (path?: string) => void;
  onDownloadModels: () => void;
  onSync: () => void;
}

const PRESET_GUIDE = [
  {
    title: "Slim",
    detail:
      "Fastest start. Best when you want light local setup and quick search.",
  },
  {
    title: "Balanced",
    detail:
      "Good default for most people. Better answers with moderate disk usage.",
  },
  {
    title: "Quality",
    detail:
      "Best local answers. Use when you are happy to spend more RAM and disk.",
  },
] as const;

function getPrimaryActionLabel(
  stage: AppStatusResponse["onboarding"]["stage"]
): string {
  switch (stage) {
    case "add-collection":
      return "Add first folder";
    case "models":
      return "Download local models";
    case "indexing":
      return "Run first sync";
    case "ready":
      return "Workspace ready";
  }
}

export function FirstRunWizard({
  onboarding,
  onAddCollection,
  onDownloadModels,
  onSync,
}: FirstRunWizardProps) {
  const handlePrimaryAction = () => {
    if (onboarding.stage === "add-collection") {
      onAddCollection();
      return;
    }
    if (onboarding.stage === "models") {
      onDownloadModels();
      return;
    }
    if (onboarding.stage === "indexing") {
      onSync();
    }
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card">
        <CardHeader className="space-y-4 pb-4">
          <div className="flex items-center gap-2 text-primary">
            <SparklesIcon className="size-4" />
            <span className="font-medium text-sm tracking-wide uppercase">
              First Run
            </span>
          </div>
          <div className="space-y-2">
            <CardTitle className="max-w-2xl text-3xl tracking-tight">
              {onboarding.headline}
            </CardTitle>
            <CardDescription className="max-w-2xl text-base text-muted-foreground">
              {onboarding.detail}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-3">
            <Button onClick={handlePrimaryAction} size="lg">
              <FolderPlusIcon className="mr-2 size-4" />
              {getPrimaryActionLabel(onboarding.stage)}
            </Button>
            <Button
              onClick={() => onAddCollection()}
              size="lg"
              variant="outline"
            >
              Choose another folder
            </Button>
          </div>

          {onboarding.suggestedCollections.length > 0 && (
            <div className="space-y-3">
              <h3 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
                Quick picks
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {onboarding.suggestedCollections.map((suggestion) => (
                  <button
                    className="rounded-xl border border-border/70 bg-background/60 p-4 text-left transition-colors hover:border-primary/40 hover:bg-background"
                    key={suggestion.path}
                    onClick={() => onAddCollection(suggestion.path)}
                    type="button"
                  >
                    <div className="mb-1 flex items-center justify-between gap-3">
                      <span className="font-medium">{suggestion.label}</span>
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </div>
                    <p className="font-mono text-muted-foreground text-xs">
                      {suggestion.path}
                    </p>
                    <p className="mt-2 text-muted-foreground text-sm">
                      {suggestion.reason}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {onboarding.steps.map((step) => (
              <div
                className="rounded-xl border border-border/70 bg-background/60 p-4"
                key={step.id}
              >
                <div className="mb-2 flex items-center gap-2">
                  <CheckCircle2Icon
                    className={`size-4 ${
                      step.status === "complete"
                        ? "text-green-500"
                        : step.status === "current"
                          ? "text-primary"
                          : "text-muted-foreground"
                    }`}
                  />
                  <span className="font-medium">{step.title}</span>
                </div>
                <p className="text-muted-foreground text-sm">{step.detail}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-secondary/25 bg-gradient-to-br from-secondary/10 via-card to-card">
        <CardHeader className="space-y-3">
          <CardTitle>Choose how GNO should feel</CardTitle>
          <CardDescription>
            Pick speed, balance, or best answers. You can switch later without
            redoing setup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            {PRESET_GUIDE.map((preset) => (
              <div
                className="rounded-xl border border-border/60 bg-background/60 p-3"
                key={preset.title}
              >
                <div className="mb-1 font-medium">{preset.title}</div>
                <p className="text-muted-foreground text-sm">{preset.detail}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-secondary/20 bg-secondary/5 p-4">
            <div className="mb-3 font-medium text-sm">Current preset</div>
            <AIModelSelector />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
