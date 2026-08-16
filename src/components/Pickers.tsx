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

function useSessionDetail(sessionID: string) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID));
  const detail = useStore((s) => s.sessionDetails[sessionID]);
  useEffect(() => {
    void loadSessionDetail(sessionID);
  }, [sessionID]);
  return { session, detail };
}

export function ModelPicker({ sessionID }: { sessionID: string }) {
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

  return (
    <div ref={ref} className="relative">
      <Button variant="outline" onClick={() => setOpen(!open)} title="Switch model" className="max-w-56 font-mono text-xs">
        <span className="truncate">
          {current ? `${current.providerID}/${current.id}${current.variant ? `@${current.variant}` : ""}` : "model"}
        </span>
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl">
          {models
            .filter((m) => m.enabled)
            .map((m) => (
              <button
                key={m.id}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-800 cursor-pointer"
                onClick={() => {
                  void switchModel(sessionID, { id: m.modelID, providerID: m.providerID }).then(refreshSessions);
                  setOpen(false);
                }}
              >
                <span>
                  <span className="font-mono text-neutral-200">{m.name}</span>
                  <span className="ml-2 font-mono text-neutral-600">{m.providerID}</span>
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

export function AgentPicker({ sessionID }: { sessionID: string }) {
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

  return (
    <div ref={ref} className="relative">
      <Button variant="outline" onClick={() => setOpen(!open)} title="Switch agent" className="max-w-32 text-xs">
        <span className="truncate">{current ?? "agent"}</span>
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 max-h-80 w-60 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl">
          {agents
            .filter((a) => !a.hidden)
            .map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-800 cursor-pointer"
                onClick={() => {
                  void switchAgent(sessionID, a.id).then(refreshSessions);
                  setOpen(false);
                }}
              >
                <span className="text-neutral-200">{a.name}</span>
                {current === a.id && <span className="text-emerald-500">✓</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
