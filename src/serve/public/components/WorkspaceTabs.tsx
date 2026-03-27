import { PlusIcon, XIcon } from "lucide-react";

import type { WorkspaceTab } from "../lib/workspace-tabs";

import { Button } from "./ui/button";

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewTab,
}: WorkspaceTabsProps) {
  return (
    <div className="border-border/50 border-b bg-background/90">
      <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto px-4 py-2">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              className={`flex items-center rounded-lg border px-2 py-1 ${
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/60 bg-card/70"
              }`}
              key={tab.id}
            >
              <button
                className="max-w-[220px] truncate px-2 py-1 text-left text-sm"
                onClick={() => onActivate(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
              <Button
                onClick={() => onClose(tab.id)}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          );
        })}
        <Button onClick={onNewTab} size="sm" variant="outline">
          <PlusIcon className="mr-2 size-4" />
          New Tab
        </Button>
      </div>
    </div>
  );
}
