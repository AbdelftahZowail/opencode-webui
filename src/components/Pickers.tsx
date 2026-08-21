import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AgentInfo, ModelInfo, ModelRef } from "../api/types";
import {
  loadSessionDetail,
  refreshSessions,
  resolveDefaultModel,
  switchAgent,
  switchModel,
  useStore,
} from "../store";
import { Button } from "./ui";

function useMenu(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [onClose]);
  return ref;
}

async function defaultAgent(): Promise<AgentInfo | undefined> {
  try {
    const agents = await api.agents();
    return agents.find((a) => a.mode === "primary" && !a.hidden) ?? agents[0];
  } catch {
    return undefined;
  }
}

export function useSessionDetail(sessionID: string) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID));
  const detail = useStore((s) => s.sessionDetails[sessionID]);
  useEffect(() => {
    void loadSessionDetail(sessionID);
  }, [sessionID]);
  return { session, detail };
}

export function ModelPicker({
  sessionID,
  openUp = false,
  align = "right",
}: {
  sessionID: string;
  openUp?: boolean;
  align?: "left" | "right";
}) {
  const { session, detail } = useSessionDetail(sessionID);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fallback, setFallback] = useState<ModelRef | null>(null);
  const ref = useMenu(() => setOpen(false));

  const current: ModelRef | undefined = detail?.model ?? session?.model ?? fallback ?? undefined;

  useEffect(() => {
    if (open && models.length === 0) void api.models().then(setModels);
  }, [open, models.length]);

  useEffect(() => {
    if (!session?.model && fallback === null) {
      void resolveDefaultModel().then((m) => {
        if (m) setFallback(m);
      });
    }
  }, [session?.model, fallback]);

  const menuPos = `${openUp ? "bottom-full mb-1" : "mt-1"} ${align === "right" ? "right-0" : "left-0"}`;

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        title="Switch model"
        className="h-7 max-w-48 gap-1 px-2 font-mono text-[11px]"
      >
        <span className="truncate">
          {current ? `${current.providerID}/${current.id}${current.variant ? `@${current.variant}` : ""}` : "model"}
        </span>
      </Button>
      {open && (
        <div
          className={`absolute z-40 max-h-80 w-72 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl ${menuPos}`}
        >
          {models
            .filter((m) => m.enabled)
            .map((m) => (
              <button
                key={`${m.providerID}/${m.modelID}`}
                type="button"
                className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-[color:var(--surface-base-hover)]"
                onClick={() => {
                  void switchModel(sessionID, { id: m.modelID, providerID: m.providerID }).then(refreshSessions);
                  setOpen(false);
                }}
              >
                <span>
                  <span className="font-mono text-[color:var(--text-strong)]">{m.name}</span>
                  <span className="ml-2 font-mono text-[color:var(--text-weaker)]">{m.providerID}</span>
                </span>
                {current?.id === m.modelID && current?.providerID === m.providerID && (
                  <span className="text-emerald-500">✓</span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function AgentPicker({
  sessionID,
  openUp = false,
  align = "right",
}: {
  sessionID: string;
  openUp?: boolean;
  align?: "left" | "right";
}) {
  const { session, detail } = useSessionDetail(sessionID);
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [fallback, setFallback] = useState<string | null>(null);
  const ref = useMenu(() => setOpen(false));

  const current: string | undefined = detail?.agent ?? session?.agent ?? fallback ?? undefined;

  useEffect(() => {
    if (open && agents.length === 0) void api.agents().then(setAgents);
  }, [open, agents.length]);

  useEffect(() => {
    if (!session?.agent && fallback === null) {
      void defaultAgent().then((a) => {
        if (a) setFallback(a.id);
      });
    }
  }, [session?.agent, fallback]);

  const menuPos = `${openUp ? "bottom-full mb-1" : "mt-1"} ${align === "right" ? "right-0" : "left-0"}`;

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        title="Switch agent (Tab)"
        className="h-7 max-w-28 px-2 text-[11px]"
      >
        <span className="truncate">{current ?? "agent"}</span>
      </Button>
      {open && (
        <div
          className={`absolute z-40 max-h-80 w-60 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl ${menuPos}`}
        >
          {agents
            .filter((a) => !a.hidden)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-[color:var(--surface-base-hover)]"
                onClick={() => {
                  void switchAgent(sessionID, a.id).then(refreshSessions);
                  setOpen(false);
                }}
              >
                <span className="text-[color:var(--text-strong)]">{a.name}</span>
                {current === a.id && <span className="text-emerald-500">✓</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
