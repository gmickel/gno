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
    <div className="border-border/40 border-b bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl items-center gap-1.5 overflow-x-auto px-4 py-2">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              className={`group flex items-center rounded-lg border px-2 py-1 transition-all duration-200 ${
                active
                  ? "border-primary/40 bg-primary/10 text-primary shadow-[0_0_12px_-4px_hsl(var(--primary)/0.25)]"
                  : "border-border/30 bg-card/40 hover:border-border/60 hover:bg-card/70"
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
                className="opacity-50 transition-opacity group-hover:opacity-100"
                onClick={() => onClose(tab.id)}
                size="icon-sm"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          );
        })}
        <Button
          className="border-dashed"
          onClick={onNewTab}
          size="sm"
          variant="outline"
        >
          <PlusIcon className="mr-1.5 size-3.5" />
          New Tab
        </Button>
      </div>
    </div>
  );
}
