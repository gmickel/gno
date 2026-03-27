import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderPlusIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { AppStatusResponse, OnboardingStep } from "../../status-model";

import { cn } from "../lib/utils";
import { AIModelSelector } from "./AIModelSelector";
import { IndexingProgress } from "./IndexingProgress";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Progress } from "./ui/progress";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";

interface FirstRunWizardProps {
  onboarding: AppStatusResponse["onboarding"];
  onAddCollection: (path?: string) => void;
  onDownloadModels: () => void;
  onEmbed: () => void;
  onSync: () => void;
  onSyncComplete?: () => void;
  embedding?: boolean;
  syncJobId?: string | null;
  syncing?: boolean;
}

function WizardPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/70 bg-card/80 shadow-sm",
        className
      )}
    >
      {children}
    </div>
  );
}

function WizardPanelHeader({
  badge,
  children,
  title,
}: {
  title: string;
  children?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="border-border/50 border-b" style={{ padding: "24px 28px" }}>
      <div className="min-w-0 flex-1">
        <div className="mb-2 font-medium text-base">{title}</div>
        {children}
      </div>
      {badge}
    </div>
  );
}

function WizardMiniCard({ body, title }: { title: string; body: string }) {
  return (
    <div
      className="rounded-xl border border-border/60 bg-background/80 shadow-none"
      style={{ padding: "20px" }}
    >
      <div className="mb-2 font-medium text-sm">{title}</div>
      <p className="text-muted-foreground text-sm leading-6">{body}</p>
    </div>
  );
}

function WizardActionPanel({
  action,
  body,
  chrome,
  title,
}: {
  title: string;
  body: string;
  action: ReactNode;
  chrome?: ReactNode;
}) {
  return (
    <div
      className="rounded-2xl border border-secondary/20 bg-secondary/5 shadow-sm"
      style={{ padding: "24px 28px" }}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="mb-2 font-medium text-sm">{title}</div>
          <p className="text-muted-foreground text-sm leading-6">{body}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-2 lg:justify-self-end lg:pt-0">
          {action}
          {chrome}
        </div>
      </div>
    </div>
  );
}

function getRecommendedStepId(
  onboarding: AppStatusResponse["onboarding"]
): string {
  const current =
    onboarding.steps.find((step) => step.status === "current") ??
    onboarding.steps.find((step) => step.status !== "complete") ??
    onboarding.steps[0];

  return current?.id ?? "folders";
}

function getStepProgress(onboarding: AppStatusResponse["onboarding"]): number {
  if (onboarding.steps.length === 0) {
    return 0;
  }

  const completeCount = onboarding.steps.filter(
    (step) => step.status === "complete"
  ).length;
  const hasCurrent = onboarding.steps.some((step) => step.status === "current");

  return Math.round(
    ((completeCount + (hasCurrent ? 0.5 : 0)) / onboarding.steps.length) * 100
  );
}

function getStepTone(step: OnboardingStep): {
  badge: string;
  className: string;
} {
  if (step.status === "complete") {
    return {
      badge: "Done",
      className:
        "border-emerald-500/25 bg-emerald-500/10 text-emerald-500 hover:border-emerald-500/40",
    };
  }

  if (step.status === "current") {
    return {
      badge: "Now",
      className:
        "border-primary/35 bg-primary/10 text-primary hover:border-primary/50",
    };
  }

  return {
    badge: "Later",
    className:
      "border-border/60 bg-background/70 text-muted-foreground hover:border-border hover:text-foreground",
  };
}

function renderStepIcon(stepId: string) {
  if (stepId === "folders") {
    return <FolderPlusIcon className="size-4" />;
  }
  if (stepId === "preset") {
    return <SparklesIcon className="size-4" />;
  }
  if (stepId === "models") {
    return <DownloadIcon className="size-4" />;
  }
  return <RefreshCwIcon className="size-4" />;
}

function getStepActionLabel(stepId: string): string {
  if (stepId === "folders") {
    return "Add folder";
  }
  if (stepId === "models") {
    return "Download models";
  }
  if (stepId === "indexing") {
    return "Run sync";
  }
  return "Review preset";
}

export function FirstRunWizard({
  onboarding,
  onAddCollection,
  onDownloadModels,
  onEmbed,
  onSync,
  onSyncComplete,
  embedding = false,
  syncJobId = null,
  syncing = false,
}: FirstRunWizardProps) {
  const recommendedStepId = getRecommendedStepId(onboarding);
  const [activeStepId, setActiveStepId] = useState(recommendedStepId);

  useEffect(() => {
    setActiveStepId((current) => {
      if (onboarding.steps.some((step) => step.id === current)) {
        return current;
      }
      return recommendedStepId;
    });
  }, [onboarding.steps, recommendedStepId]);

  const steps = onboarding.steps;
  const foldersStep = steps.find((step) => step.id === "folders");
  const foldersConnected = foldersStep?.status === "complete";
  const activeStep =
    steps.find((step) => step.id === activeStepId) ?? steps[0] ?? null;
  const activeIndex = activeStep
    ? steps.findIndex((step) => step.id === activeStep.id)
    : 0;
  const previousStep = activeIndex > 0 ? steps[activeIndex - 1] : null;
  const nextStep =
    activeIndex >= 0 && activeIndex < steps.length - 1
      ? steps[activeIndex + 1]
      : null;
  const progressValue = getStepProgress(onboarding);
  const isShowingRecommended = activeStep?.id === recommendedStepId;
  const indexingNeedsEmbeddings =
    onboarding.stage === "indexing" &&
    onboarding.detail.toLowerCase().includes("embedding");

  const runRecommendedAction = () => {
    if (!activeStep) {
      return;
    }
    if (activeStep.id === "folders") {
      onAddCollection();
      return;
    }
    if (activeStep.id === "models") {
      onDownloadModels();
      return;
    }
    if (activeStep.id === "indexing" && indexingNeedsEmbeddings && !embedding) {
      onEmbed();
      return;
    }
    if (activeStep.id === "indexing" && !syncing) {
      onSync();
    }
  };

  const renderStepBody = () => {
    if (!activeStep) {
      return null;
    }

    if (activeStep.id === "folders") {
      return (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => onAddCollection()} size="lg">
              <FolderPlusIcon className="mr-2 size-4" />
              {foldersConnected ? "Add another folder" : "Add first folder"}
            </Button>
            <Button
              onClick={() => onAddCollection()}
              size="lg"
              variant="outline"
            >
              {foldersConnected
                ? "Browse for more folders"
                : "Browse for another folder"}
            </Button>
          </div>

          {onboarding.suggestedCollections.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">
                    {foldersConnected
                      ? "Suggested next folders"
                      : "Recommended starting points"}
                  </h3>
                  <p className="text-muted-foreground text-sm">
                    {foldersConnected
                      ? "Add another source quickly from the common local spots below."
                      : "Pick one to prefill the add-folder dialog."}
                  </p>
                </div>
                <Badge variant="outline">Quick picks</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {onboarding.suggestedCollections.map((suggestion) => (
                  <button
                    className="rounded-xl border border-border/70 bg-background/80 p-4 text-left shadow-sm transition-all hover:border-primary/35 hover:bg-background hover:shadow-md"
                    key={suggestion.path}
                    onClick={() => onAddCollection(suggestion.path)}
                    type="button"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-medium">{suggestion.label}</span>
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </div>
                    <p className="font-mono text-muted-foreground text-xs">
                      {suggestion.path}
                    </p>
                    <p className="mt-3 text-muted-foreground text-sm">
                      {suggestion.reason}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (activeStep.id === "preset") {
      return (
        <div className="space-y-5">
          <WizardPanel className="border-secondary/25 bg-secondary/5">
            <WizardPanelHeader
              badge={<Badge variant="outline">Safe to switch</Badge>}
              title="Preset selector"
            >
              <p className="max-w-3xl text-muted-foreground text-sm leading-6">
                Pick the preset here. The active card below explains the
                trade-off, model footprint, and whether a tuned preset is
                available.
              </p>
            </WizardPanelHeader>
            <div style={{ padding: "24px 28px" }}>
              <AIModelSelector showDetails showDownloadAction={false} />
            </div>
          </WizardPanel>
        </div>
      );
    }

    if (activeStep.id === "models") {
      return (
        <div className="space-y-5">
          <WizardPanel>
            <WizardPanelHeader
              badge={<Badge variant="outline">Background download</Badge>}
              title="Local model readiness"
            >
              <p className="max-w-2xl text-muted-foreground text-sm leading-6">
                {activeStep.detail}
              </p>
            </WizardPanelHeader>
            <div style={{ padding: "24px 28px" }}>
              <div className="grid gap-4 md:grid-cols-2">
                <WizardMiniCard
                  body="Core search is already usable. You can keep exploring while the heavier local model roles download."
                  title="What you have now"
                />
                <WizardMiniCard
                  body="Better reranking, stronger local answers, and a cleaner first run experience once the active preset is fully cached."
                  title="What improves next"
                />
              </div>
            </div>
          </WizardPanel>

          <WizardActionPanel
            action={
              <Button onClick={onDownloadModels} size="lg">
                <DownloadIcon className="mr-2 size-4" />
                Download local models
              </Button>
            }
            body="Safe to start now. You do not need to stay on this step."
            chrome={
              <Badge className="px-3 py-1" variant="outline">
                Runs in background
              </Badge>
            }
            title="Download active preset"
          />
        </div>
      );
    }

    return (
      <div className="space-y-5">
        <WizardPanel>
          <WizardPanelHeader
            badge={<Badge variant="outline">Safe to rerun</Badge>}
            title="Finish first indexing"
          >
            <p className="max-w-2xl text-muted-foreground text-sm leading-6">
              {activeStep.detail}
            </p>
          </WizardPanelHeader>
          <div style={{ padding: "24px 28px" }}>
            <WizardMiniCard
              body="Pulls the current folder state into the index and reconciles the first-run workspace so search, browse, and health data line up."
              title="What this does"
            />
          </div>
        </WizardPanel>

        <WizardActionPanel
          action={
            <Button
              disabled={indexingNeedsEmbeddings ? embedding : syncing}
              onClick={indexingNeedsEmbeddings ? onEmbed : onSync}
              size="lg"
            >
              <RefreshCwIcon className="mr-2 size-4" />
              {indexingNeedsEmbeddings
                ? embedding
                  ? "Embedding..."
                  : "Finish embeddings"
                : syncing
                  ? "Syncing..."
                  : "Run first sync"}
            </Button>
          }
          body={
            indexingNeedsEmbeddings
              ? "Your files are indexed. One more embedding pass will unlock semantic search and local answers."
              : "Good last step before you move into normal use."
          }
          title={
            indexingNeedsEmbeddings
              ? "Finish semantic indexing"
              : "Index the current workspace"
          }
        />

        {syncJobId && (
          <WizardPanel>
            <WizardPanelHeader title="Sync progress">
              <p className="max-w-2xl text-muted-foreground text-sm leading-6">
                Your first indexing run is in progress. The wizard will advance
                once the job finishes and embeddings catch up.
              </p>
            </WizardPanelHeader>
            <div style={{ padding: "24px 28px" }}>
              <IndexingProgress jobId={syncJobId} onComplete={onSyncComplete} />
            </div>
          </WizardPanel>
        )}
      </div>
    );
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="border-primary/15 bg-gradient-to-b from-card via-card to-primary/5">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-primary">
              <SparklesIcon className="size-4" />
              <span className="font-medium text-sm tracking-wide uppercase">
                Setup wizard
              </span>
            </div>
            <Badge variant="outline">{progressValue}%</Badge>
          </div>
          <div className="space-y-2">
            <CardTitle className="text-2xl tracking-tight">
              {onboarding.headline}
            </CardTitle>
            <CardDescription>{onboarding.detail}</CardDescription>
          </div>
          <Progress value={progressValue} />
        </CardHeader>
        <CardContent className="pt-0">
          <ScrollArea className="max-h-[420px] pr-3">
            <div className="space-y-3">
              {steps.map((step, index) => {
                const tone = getStepTone(step);
                const isActive = step.id === activeStep?.id;

                return (
                  <button
                    className={cn(
                      "w-full rounded-2xl border p-4 text-left shadow-sm transition-all",
                      tone.className,
                      isActive &&
                        "ring-2 ring-primary/20 ring-offset-2 ring-offset-background"
                    )}
                    key={step.id}
                    onClick={() => setActiveStepId(step.id)}
                    type="button"
                  >
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-full border text-sm",
                            step.status === "complete"
                              ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-500"
                              : step.status === "current"
                                ? "border-primary/30 bg-primary/10 text-primary"
                                : "border-border/70 bg-background/70 text-muted-foreground"
                          )}
                        >
                          {step.status === "complete" ? (
                            <CheckCircle2Icon className="size-4" />
                          ) : (
                            index + 1
                          )}
                        </div>
                        <div>
                          <div className="font-medium">{step.title}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Step {index + 1}
                          </div>
                        </div>
                      </div>
                      <Badge variant="outline">{tone.badge}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {step.detail}
                    </p>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="border-primary/20 bg-gradient-to-br from-primary/8 via-card to-card">
        <CardHeader className="space-y-4 border-border/50 border-b bg-background/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary">
                {activeStep ? renderStepIcon(activeStep.id) : null}
              </div>
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="outline">
                    Step {Math.max(activeIndex + 1, 1)} of {steps.length || 1}
                  </Badge>
                  {isShowingRecommended && (
                    <Badge className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/10">
                      Recommended now
                    </Badge>
                  )}
                </div>
                <CardTitle className="text-3xl tracking-tight">
                  {activeStep?.id === "preset"
                    ? "Choose how GNO should feel"
                    : (activeStep?.title ?? onboarding.headline)}
                </CardTitle>
              </div>
            </div>
            {activeStep && activeStep.id !== "preset" && (
              <Button
                disabled={
                  activeStep.id === "indexing"
                    ? indexingNeedsEmbeddings
                      ? embedding
                      : syncing
                    : false
                }
                onClick={runRecommendedAction}
                size="sm"
                variant={isShowingRecommended ? "default" : "outline"}
              >
                {activeStep.id === "indexing" && indexingNeedsEmbeddings
                  ? embedding
                    ? "Embedding..."
                    : "Finish embeddings"
                  : activeStep.id === "indexing" && syncing
                    ? "Syncing..."
                    : getStepActionLabel(activeStep.id)}
              </Button>
            )}
          </div>
          <CardDescription className="max-w-3xl text-base">
            {activeStep?.detail ?? onboarding.detail}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 p-6">{renderStepBody()}</CardContent>
        <Separator />
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 p-6">
          <Button
            disabled={!previousStep}
            onClick={() => previousStep && setActiveStepId(previousStep.id)}
            variant="outline"
          >
            <ChevronLeftIcon className="mr-2 size-4" />
            Previous
          </Button>
          <div className="text-muted-foreground text-sm">
            You can jump between steps without losing progress.
          </div>
          <Button
            disabled={!nextStep}
            onClick={() => nextStep && setActiveStepId(nextStep.id)}
            variant="outline"
          >
            Next
            <ChevronRightIcon className="ml-2 size-4" />
          </Button>
        </CardFooter>
      </Card>
    </section>
  );
}
