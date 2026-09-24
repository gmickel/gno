import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import type {
  SessionAutomationRunResult,
  SessionAutomationStatus,
  SessionProfileStatus,
  SessionSourceStatus,
} from "./api";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { sessionsApi } from "./api";

const PROFILE_ID_PATTERN = "[a-z0-9][a-z0-9_-]{0,63}";
const CADENCE_PATTERN = "[1-9][0-9]{0,5}[smhd]";

/** Local-only preview returned before a trigger is switched on. */
interface AutomationPreview {
  archiveRoot: string;
  sources: Array<{
    id: string;
    harness: string | null;
    path: string | null;
    collection: string | null;
  }>;
  collections: string[];
  hook: { settings: string; command: string };
  daemon: { state: string; command: string };
  notes: string[];
}

type Trigger = "hook" | "schedule";

const STATE_LABELS: Record<SessionProfileStatus["state"], string> = {
  off: "off",
  idle: "idle",
  pending: "pending",
  running: "running",
  retrying: "retrying",
  partial: "partial",
  failed: "needs attention",
};

function stateVariant(
  state: SessionProfileStatus["state"]
): "secondary" | "outline" | "destructive" {
  if (state === "failed") return "destructive";
  if (state === "off" || state === "idle") return "outline";
  return "secondary";
}

/** Poll status this often while a run is in progress. */
const RUN_POLL_MS = 2000;

type Notify = (text: string) => void;

function scheduleLine(
  daemonRunning: boolean,
  nextDueAt: string | null,
  at: (iso: string | null) => string
): string {
  if (!daemonRunning) return "not running: no daemon";
  return nextDueAt ? `next ${at(nextDueAt)}` : "due time set on the next tick";
}

/** After Run now: the retry time, the recovery action, or remaining work. */
function runOutcomeTail(
  run: SessionAutomationRunResult,
  profile: SessionProfileStatus,
  at: (iso: string | null) => string
): string {
  if (run.outcome === "failed") {
    if (profile.state === "retrying" && profile.retryAt) {
      return `; retried automatically at ${at(profile.retryAt)}`;
    }
    return profile.recovery ? "; see the recovery action above" : "";
  }
  return run.pending ? "; work is still pending" : "";
}

function clockFor(timezone: string): (iso: string | null) => string {
  return (iso) => {
    if (!iso) return "never";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    try {
      return date.toLocaleString(undefined, { timeZone: timezone });
    } catch {
      return date.toLocaleString();
    }
  };
}

function CreateProfileForm({
  sources,
  onDone,
  notify,
}: {
  sources: SessionSourceStatus[];
  onDone: () => Promise<void>;
  notify: Notify;
}) {
  const idField = useId();
  const [id, setId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<{ text: string; nonce: number } | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const fail = (text: string) =>
    setError((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected.length === 0) {
      fail("Select at least one registered source.");
      return;
    }
    setSaving(true);
    const result = await sessionsApi(
      `/api/sessions/automation/${encodeURIComponent(id.trim())}`,
      { method: "PUT", body: JSON.stringify({ sources: selected }) }
    );
    setSaving(false);
    if (result.error) {
      fail(result.error);
      return;
    }
    const created = id.trim();
    setError(null);
    setId("");
    setSelected([]);
    await onDone();
    notify(`Profile ${created} created; every trigger is off.`);
  };

  return (
    <form
      aria-label="Create automation profile"
      className="space-y-3 rounded-lg border border-dashed border-border/70 p-4"
      onSubmit={(event) => void submit(event)}
    >
      <label className="grid max-w-xs gap-1 text-sm" htmlFor={idField}>
        Profile ID
        <Input
          id={idField}
          onChange={(event) => setId(event.currentTarget.value)}
          pattern={PROFILE_ID_PATTERN}
          placeholder="claude"
          required
          value={id}
        />
      </label>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1">Sources this profile imports</legend>
        {sources.map((source) => (
          <label className="flex items-center gap-2" key={source.id}>
            <input
              checked={selected.includes(source.id)}
              onChange={(event) => {
                const { checked } = event.currentTarget;
                setSelected((current) =>
                  checked
                    ? [...current, source.id]
                    : current.filter((item) => item !== source.id)
                );
              }}
              type="checkbox"
            />
            <span className="break-all font-mono">{`${source.id} → ${source.collection}`}</span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p
          className="break-words text-destructive text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {error.text}
        </p>
      )}
      <Button disabled={saving} size="sm" type="submit">
        {saving && <Loader2Icon className="animate-spin" />}
        Create profile (everything stays off)
      </Button>
    </form>
  );
}

function PreviewConfirm({
  trigger,
  preview,
  cadence,
  onCadence,
  saving,
  onConfirm,
  onCancel,
}: {
  trigger: Trigger;
  preview: AutomationPreview;
  cadence: string;
  onCadence: (value: string) => void;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cadenceField = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    groupRef.current?.focus();
  }, []);
  return (
    <div
      aria-label={`Confirm ${trigger === "hook" ? "Claude Code hook" : "schedule"}`}
      className="min-w-0 space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      ref={groupRef}
      role="group"
      tabIndex={-1}
    >
      <p className="font-medium">
        {trigger === "hook"
          ? "Install the Claude Code SessionEnd hook?"
          : "Run this profile on the daemon's schedule?"}
      </p>
      <ul className="list-disc space-y-1 pl-5">
        {preview.sources.map((source) => (
          <li className="break-all" key={source.id}>
            <span className="font-mono">{source.id}</span>{" "}
            {source.path ?? "not registered"} → {source.collection ?? "none"}
          </li>
        ))}
        <li className="break-all">Archive: {preview.archiveRoot}</li>
        {trigger === "hook" && (
          <li className="break-all">
            Adds one owned entry to {preview.hook.settings}; other hooks are
            kept.
          </li>
        )}
      </ul>
      {trigger === "schedule" && (
        <label className="grid max-w-[10rem] gap-1" htmlFor={cadenceField}>
          Every (elapsed, min 1m)
          <Input
            id={cadenceField}
            onChange={(event) => onCadence(event.currentTarget.value)}
            pattern={CADENCE_PATTERN}
            placeholder="1h"
            required
            value={cadence}
          />
        </label>
      )}
      <p className="text-muted-foreground">
        Daemon:{" "}
        {preview.daemon.state === "running"
          ? "running"
          : "not running: no daemon"}
        . Runs happen only while{" "}
        <code className="break-all font-mono text-xs">
          {preview.daemon.command}
        </code>{" "}
        runs; GNO never installs or starts it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={saving || (trigger === "schedule" && !cadence.trim())}
          onClick={onConfirm}
          size="sm"
        >
          {saving && <Loader2Icon className="animate-spin" />}
          Enable
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ProfileCard({
  profile,
  timezone,
  daemonRunning,
  localClient,
  onChanged,
  notify,
  onRunActive,
}: {
  profile: SessionProfileStatus;
  timezone: string;
  daemonRunning: boolean;
  localClient: boolean;
  onChanged: () => Promise<void>;
  notify: Notify;
  onRunActive: (active: boolean) => void;
}) {
  const at = clockFor(timezone);
  const hookSwitch = useId();
  const scheduleSwitch = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; nonce: number } | null>(
    null
  );
  const [confirming, setConfirming] = useState<{
    trigger: Trigger;
    preview: AutomationPreview;
  } | null>(null);
  const [cadence, setCadence] = useState(profile.schedule?.cadence ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const removeReturnFocus = useRef(false);
  // The Remove button unmounts when its confirm step opens: move focus to
  // Confirm, and back to Remove on Cancel.
  useEffect(() => {
    if (confirmRemove) confirmRemoveRef.current?.focus();
    else if (removeReturnFocus.current) {
      removeReturnFocus.current = false;
      removeRef.current?.focus();
    }
  }, [confirmRemove]);
  const [lastRun, setLastRun] = useState<SessionAutomationRunResult | null>(
    null
  );
  const base = `/api/sessions/automation/${encodeURIComponent(profile.id)}`;
  const switches = {
    hook: useRef<HTMLInputElement>(null),
    schedule: useRef<HTMLInputElement>(null),
  };
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Disabled buttons drop keyboard focus; hand it to the outcome instead.
  useEffect(() => {
    if (lastRun) outcomeRef.current?.focus();
  }, [lastRun]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const closeConfirm = (trigger: Trigger) => {
    setConfirming(null);
    switches[trigger].current?.focus();
  };

  const call = async <T,>(
    label: string,
    endpoint: string,
    init: RequestInit
  ): Promise<T | null> => {
    setBusy(label);
    const result = await sessionsApi<T>(endpoint, init);
    setBusy(null);
    if (result.error) {
      const text = result.error;
      setError((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));
      return null;
    }
    setError(null);
    return result.data;
  };

  const startEnable = async (trigger: Trigger) => {
    const preview = await call<AutomationPreview>(
      "preview",
      `${base}/preview`,
      {
        method: "GET",
      }
    );
    if (preview) setConfirming({ trigger, preview });
  };

  const confirmEnable = async () => {
    if (!confirming) return;
    const body =
      confirming.trigger === "hook"
        ? { hook: { harness: "claude-code" } }
        : { schedule: { cadence: cadence.trim() } };
    const done = await call("enable", `${base}/enable`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (done) {
      closeConfirm(confirming.trigger);
      await onChanged();
    }
  };

  const disable = async (which: Partial<Record<Trigger, boolean>>) => {
    const done = await call("disable", `${base}/disable`, {
      method: "POST",
      body: JSON.stringify(which),
    });
    if (!done) return;
    await onChanged();
    // The Pause button is gone once nothing is enabled: land on a switch.
    (which.schedule && !which.hook
      ? switches.schedule
      : switches.hook
    ).current?.focus();
  };

  const toggle = (trigger: Trigger, on: boolean) => {
    // Switches stay focusable while a request or confirmation is open.
    if (busy !== null || confirming !== null) return;
    if (on) void startEnable(trigger);
    else void disable({ [trigger]: true });
  };

  const runNow = async () => {
    onRunActive(true);
    const result = await call<SessionAutomationRunResult>(
      "run",
      "/api/sessions/automation/run",
      { method: "POST", body: JSON.stringify({ profileId: profile.id }) }
    ).finally(() => onRunActive(false));
    if (result) {
      setLastRun(result);
      await onChanged();
    }
  };

  const remove = async () => {
    const done = await call("remove", base, { method: "DELETE" });
    if (!done) return;
    // Announce (and focus) before the refresh unmounts this card.
    notify(`Profile ${profile.id} removed; archived sessions were kept.`);
    await onChanged();
  };

  const hookOn = profile.hook?.enabled === true;
  const scheduleOn = profile.schedule?.enabled === true;
  const run = profile.lastRun;
  return (
    <li className="min-w-0 space-y-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all font-mono font-semibold">{profile.id}</h3>
            <Badge variant={stateVariant(profile.state)}>
              {STATE_LABELS[profile.state]}
            </Badge>
          </div>
          <p className="break-words text-muted-foreground text-sm">
            {`Sources ${profile.sources.join(", ")} → ${profile.collections.join(", ") || "no collection"} · ${profile.limit} units per source per run`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            aria-label={`Run ${profile.id} now`}
            disabled={busy !== null}
            onClick={() => void runNow()}
            size="sm"
          >
            {busy === "run" ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlayIcon />
            )}
            Run now
          </Button>
          {localClient && (hookOn || scheduleOn) && (
            <Button
              aria-label={`Pause ${profile.id}`}
              disabled={busy !== null}
              onClick={() => void disable({})}
              size="sm"
              variant="outline"
            >
              <PauseIcon />
              Pause
            </Button>
          )}
          {localClient &&
            (confirmRemove ? (
              <>
                <Button
                  aria-disabled={busy !== null}
                  onClick={() => {
                    if (busy === null) void remove();
                  }}
                  ref={confirmRemoveRef}
                  size="sm"
                  variant="destructive"
                >
                  Confirm remove
                </Button>
                <Button
                  onClick={() => {
                    setConfirmRemove(false);
                    removeReturnFocus.current = true;
                  }}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                aria-label={`Remove profile ${profile.id}`}
                disabled={busy !== null}
                onClick={() => setConfirmRemove(true)}
                ref={removeRef}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon />
                Remove
              </Button>
            ))}
        </div>
      </div>

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <label className="flex items-start gap-2" htmlFor={hookSwitch}>
          <input
            aria-disabled={busy !== null || confirming !== null}
            checked={hookOn}
            className="mt-1"
            disabled={!localClient}
            id={hookSwitch}
            onChange={(event) => toggle("hook", event.currentTarget.checked)}
            ref={switches.hook}
            role="switch"
            type="checkbox"
          />
          <span className="min-w-0">
            Claude Code SessionEnd hook
            <span className="block text-muted-foreground text-xs">
              {hookOn
                ? profile.hook?.installed === false
                  ? "on, but the settings entry is missing"
                  : "on: session ends mark this profile pending"
                : "off"}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2" htmlFor={scheduleSwitch}>
          <input
            aria-disabled={busy !== null || confirming !== null}
            checked={scheduleOn}
            className="mt-1"
            disabled={!localClient}
            id={scheduleSwitch}
            onChange={(event) =>
              toggle("schedule", event.currentTarget.checked)
            }
            ref={switches.schedule}
            role="switch"
            type="checkbox"
          />
          <span className="min-w-0">
            Daemon schedule
            <span className="block text-muted-foreground text-xs">
              {scheduleOn
                ? `every ${profile.schedule?.cadence}; ${scheduleLine(
                    daemonRunning,
                    profile.schedule?.nextDueAt ?? null,
                    at
                  )}`
                : "off"}
            </span>
          </span>
        </label>
      </div>

      {confirming && (
        <PreviewConfirm
          cadence={cadence}
          onCadence={setCadence}
          onCancel={() => closeConfirm(confirming.trigger)}
          onConfirm={() => void confirmEnable()}
          preview={confirming.preview}
          saving={busy === "enable"}
          trigger={confirming.trigger}
        />
      )}

      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {profile.pending && profile.state !== "failed" && (
          <>
            <dt className="text-muted-foreground">Pending</dt>
            <dd>
              since {at(profile.pending.since)} (
              {profile.pending.triggers.join(", ") || "continuation"})
              {profile.retryAt && `; retry at ${at(profile.retryAt)}`}
            </dd>
          </>
        )}
        {profile.running && (
          <>
            <dt className="text-muted-foreground">Running</dt>
            <dd>since {at(profile.running.startedAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Last run</dt>
        <dd className="break-words">
          {run
            ? `${at(run.finishedAt)}: ${run.outcome}${run.reason ? ` (${run.reason})` : ""}; ${run.threads.imported} imported, ${run.threads.updated} updated, ${run.units.failed} failed units`
            : "never"}
        </dd>
        <dt className="text-muted-foreground">Last success</dt>
        <dd>{at(profile.lastSuccessAt)}</dd>
      </dl>

      {profile.recovery && (
        <p
          className="break-words rounded-md bg-amber-500/10 px-3 py-2 text-amber-900 text-sm dark:text-amber-100"
          role="status"
        >
          {profile.recovery}
        </p>
      )}
      {lastRun && (
        <p
          className="break-words text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          ref={outcomeRef}
          role="status"
          tabIndex={-1}
        >
          Run now:{" "}
          {lastRun.ran
            ? `${lastRun.outcome}${lastRun.reason ? ` (${lastRun.reason})` : ""}`
            : `not started (${lastRun.reason ?? "unknown"})`}
          {runOutcomeTail(lastRun, profile, at)}
        </p>
      )}
      {error && (
        <p
          className="break-words text-destructive text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {error.text}
        </p>
      )}
    </li>
  );
}

export interface AutomationPanelProps {
  automation: SessionAutomationStatus;
  sources: SessionSourceStatus[];
  localClient: boolean;
  onChanged: () => Promise<void>;
}

/**
 * Opt-in automation: every trigger is off until a same-host owner switches
 * it on after reviewing the preview. Remote browsers can read status and run
 * a configured profile, never enable machine integrations.
 */
export function AutomationPanel({
  automation,
  sources,
  localClient,
  onChanged,
}: AutomationPanelProps) {
  const at = clockFor(automation.timezone);
  const daemonRunning = automation.daemon.state === "running";
  const [notice, setNotice] = useState<{ text: string; nonce: number } | null>(
    null
  );
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const notify: Notify = (text) =>
    setNotice((current) => ({ text, nonce: (current?.nonce ?? 0) + 1 }));

  // Poll while a run is in progress (here, in the daemon, or requested from
  // this page) so running/pending states appear without a reload.
  const [runsInFlight, setRunsInFlight] = useState(0);
  const onRunActive = (active: boolean) =>
    setRunsInFlight((count) => Math.max(0, count + (active ? 1 : -1)));
  const active =
    runsInFlight > 0 ||
    automation.profiles.some(
      (profile) =>
        profile.state === "running" ||
        (daemonRunning && profile.state === "pending")
    );
  const refresh = useRef(onChanged);
  refresh.current = onChanged;
  useEffect(() => {
    if (!active) return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void refresh.current().finally(() => {
        polling = false;
      });
    }, RUN_POLL_MS);
    return () => clearInterval(timer);
  }, [active]);
  let daemonLine = "not running: no daemon";
  if (daemonRunning) {
    daemonLine = `running (heartbeat ${at(automation.daemon.heartbeatAt)})`;
  } else if (automation.daemon.state === "stale") {
    daemonLine = `stale (last heartbeat ${at(automation.daemon.heartbeatAt)})`;
  }
  return (
    <section
      aria-labelledby="sessions-automation-heading"
      className="space-y-4"
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <WorkflowIcon aria-hidden="true" className="size-5 text-primary" />
          <h2
            className="font-semibold text-xl"
            id="sessions-automation-heading"
          >
            Automation
          </h2>
          <Badge variant="outline">
            {automation.profiles.some(
              (profile) => profile.hook?.enabled || profile.schedule?.enabled
            )
              ? "opt-in enabled"
              : "manual"}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Off by default. A hook or schedule only marks a profile pending; the
          import runs in <span className="font-mono">gno daemon</span> on this
          archive (or with Run now).{" "}
          <span className="font-mono">gno serve</span> never runs it. Daemon:{" "}
          {daemonLine}. Times in {automation.timezone}.
        </p>
        {!localClient && (
          <p className="text-muted-foreground text-xs">
            Only a browser on this machine can change hooks or schedules.
          </p>
        )}
      </div>
      {automation.profiles.length > 0 && (
        <ul className="space-y-3">
          {automation.profiles.map((profile) => (
            <ProfileCard
              daemonRunning={daemonRunning}
              key={profile.id}
              localClient={localClient}
              notify={notify}
              onChanged={onChanged}
              onRunActive={onRunActive}
              profile={profile}
              timezone={automation.timezone}
            />
          ))}
        </ul>
      )}
      {localClient && sources.length > 0 && (
        <CreateProfileForm
          notify={notify}
          onDone={onChanged}
          sources={sources}
        />
      )}
      {notice && (
        <p
          className="break-words text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          ref={noticeRef}
          role="status"
          tabIndex={-1}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
