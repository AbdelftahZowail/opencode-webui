import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, BookMarked, File, Folder, Plug, Sparkles } from "lucide-react";
import { api } from "../api/client";
import type { FsEntry, McpResource, ReferenceInfo } from "../api/client";
import type { AgentInfo, SkillInfo } from "../api/types";
import { frecencyScore } from "../lib/frecency";
import { loadFrecency, recordFileUsage } from "../lib/frecencyStore";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

/** The kinds an `@` reference can resolve to (parity R8). */
export type MentionKind = "file" | "agent" | "skill" | "mcp" | "reference";

/** What the composer receives when a mention row is picked. */
export interface MentionPick {
  kind: MentionKind;
  /** The token inserted into the composer, including the leading `@`. */
  mention: string;
  entry?: FsEntry;
  agent?: AgentInfo;
  skill?: SkillInfo;
  resource?: McpResource;
  reference?: ReferenceInfo;
}

interface FilePickerProps {
  open: boolean;
  query: string;
  location?: string;
  onOpenChange: (open: boolean) => void;
  onPick: (pick: MentionPick) => void;
  children: ReactNode;
}

/** v2 caps the `@` autocomplete at ten rows (`autocomplete.tsx:501-520`). */
const MENTION_LIMIT = 10;

const KIND_LABEL: Record<MentionKind, string> = {
  file: "file",
  agent: "agent",
  skill: "skill",
  mcp: "mcp",
  reference: "ref",
};

// ---- catalogs (one-shot, cached) ------------------------------------------
//
// Agents / skills / MCP resources / reference aliases are the "beyond files"
// `@` targets. They change rarely, so one shared fetch per page (mirrors the
// composer's cached model/agent loaders) — components fetching one-shot
// catalog data is the sanctioned exception to "the store owns state".

interface MentionCatalog {
  agents: AgentInfo[];
  skills: SkillInfo[];
  resources: McpResource[];
  references: ReferenceInfo[];
}

const EMPTY_CATALOG: MentionCatalog = { agents: [], skills: [], resources: [], references: [] };
let catalog: MentionCatalog | null = null;
let catalogPromise: Promise<MentionCatalog> | null = null;

function loadCatalog(location?: string): Promise<MentionCatalog> {
  if (catalog) return Promise.resolve(catalog);
  catalogPromise ??= Promise.all([
    api.agents().catch(() => [] as AgentInfo[]),
    api.skills().catch(() => [] as SkillInfo[]),
    api
      .mcpResource(location ? { directory: location } : undefined)
      .then((r) => r.data.resources)
      .catch(() => [] as McpResource[]),
    api.referenceList().then((r) => r.data).catch(() => [] as ReferenceInfo[]),
  ]).then(([agents, skills, resources, references]) => {
    catalog = { agents, skills, resources, references };
    return catalog;
  });
  return catalogPromise;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Dependency-free fuzzy score over one or more target strings. Mirrors the
 * composer's slash matcher (prefix > substring > subsequence) and returns 0 on
 * no match so frecency only ever reorders real matches.
 */
function fuzzyScore(query: string, ...targets: string[]): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  let best = 0;
  for (const target of targets) {
    const t = target.toLowerCase();
    if (!t) continue;
    const base = t.split("/").pop() ?? t;
    if (t === q || base === q) best = Math.max(best, 1000);
    else if (t.startsWith(q) || base.startsWith(q)) best = Math.max(best, 700);
    else if (t.includes(q)) best = Math.max(best, 300);
    else if (isSubsequence(q, t)) best = Math.max(best, 100);
  }
  return best;
}

interface MentionItem {
  key: string;
  kind: MentionKind;
  label: string;
  search: string;
  mention: string;
  icon: ReactNode;
  entry?: FsEntry;
  agent?: AgentInfo;
  skill?: SkillInfo;
  resource?: McpResource;
  reference?: ReferenceInfo;
}

function toPick(item: MentionItem): MentionPick {
  return {
    kind: item.kind,
    mention: item.mention,
    entry: item.entry,
    agent: item.agent,
    skill: item.skill,
    resource: item.resource,
    reference: item.reference,
  };
}

/**
 * @-mention autocomplete (parity R8): files, agents, skills, MCP resources and
 * reference aliases in ONE fuzzy + frecency-ranked list, capped at ten. The
 * popover hosts a <Command> instance whose selection is driven IMPERATIVELY
 * from the wrapped textarea's onKeyDown (Composer routes ArrowUp/Down to
 * commandMove and Enter/Tab to commandSelectActive) — no document-level keys.
 */
export function FilePicker({ open, query, location, onOpenChange, onPick, children }: FilePickerProps) {
  const [files, setFiles] = useState<FsEntry[]>([]);
  const [cat, setCat] = useState<MentionCatalog>(catalog ?? EMPTY_CATALOG);
  const [resolvedLocation, setResolvedLocation] = useState<string | undefined>(location);

  useEffect(() => {
    if (open && !location && !resolvedLocation) {
      void api
        .location()
        .then((loc) => setResolvedLocation(loc.directory))
        .catch(() => undefined);
    }
  }, [open, location, resolvedLocation]);

  // One-shot catalogs — fetched once per page, refreshes on each open.
  useEffect(() => {
    if (!open) return;
    void loadCatalog(resolvedLocation).then(setCat);
  }, [open, resolvedLocation]);

  useEffect(() => {
    if (!open) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .fsFind(query, { location: resolvedLocation, limit: 20 })
        .then((res) => {
          if (!cancelled) setFiles(res.data);
        })
        .catch(() => {
          if (!cancelled) setFiles([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, resolvedLocation]);

  const fileFrecency = useMemo(() => loadFrecency(resolvedLocation), [resolvedLocation]);
  const globalFrecency = useMemo(() => loadFrecency(undefined), []);

  const items = useMemo<MentionItem[]>(() => {
    const all: MentionItem[] = [
      ...files.map((entry) => ({
        key: entry.path,
        kind: "file" as const,
        label: entry.path,
        search: entry.path,
        mention: `@${entry.path}`,
        icon:
          entry.type === "directory" ? (
            <Folder className="text-[color:var(--text-weak)]" />
          ) : (
            <File className="text-[color:var(--text-weak)]" />
          ),
        entry,
      })),
      ...cat.agents.map((agent) => ({
        key: `agent:${agent.id}`,
        kind: "agent" as const,
        label: agent.name,
        search: `${agent.name} ${agent.id}`,
        mention: `@${agent.name}`,
        icon: <Bot className="text-[color:var(--text-interactive-base)]" />,
        agent,
      })),
      ...cat.skills.map((skill) => ({
        key: `skill:${skill.id}`,
        kind: "skill" as const,
        label: skill.name,
        search: `${skill.name} ${skill.id}`,
        mention: `@${skill.name}`,
        icon: <Sparkles className="text-[color:var(--text-interactive-base)]" />,
        skill,
      })),
      ...cat.resources.map((resource) => ({
        key: `mcp:${resource.server}:${resource.uri}`,
        kind: "mcp" as const,
        label: resource.name,
        search: `${resource.name} ${resource.uri} ${resource.server}`,
        mention: `@${resource.uri}`,
        icon: <Plug className="text-[color:var(--text-weak)]" />,
        resource,
      })),
      ...cat.references.map((reference) => ({
        key: `ref:${reference.name}`,
        kind: "reference" as const,
        label: reference.name,
        search: `${reference.name} ${reference.path}`,
        mention: `@${reference.name}`,
        icon: <BookMarked className="text-[color:var(--text-weak)]" />,
        reference,
      })),
    ];
    const ranked = all
      .map((item, index) => ({
        item,
        index,
        score:
          fuzzyScore(query, item.search, item.label) *
          (1 + frecencyScore((item.kind === "file" ? fileFrecency : globalFrecency)[item.key])),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, MENTION_LIMIT)
      .map((row) => row.item);
    return ranked;
  }, [files, cat, query, fileFrecency, globalFrecency]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandList>
            {items.length > 0 ? (
              <CommandGroup heading="References">
                {items.map((item) => (
                  <CommandItem
                    key={item.key}
                    value={item.key}
                    onSelect={() => {
                      // Record the pick where it is observed — the same moment
                      // v2's autocomplete records frecency. Files are scoped to
                      // the project; global kinds share the no-directory bucket.
                      recordFileUsage(item.kind === "file" ? resolvedLocation : undefined, item.key);
                      onPick(toPick(item));
                    }}
                  >
                    {item.icon}
                    <span className="min-w-0 truncate font-mono text-[color:var(--text-strong)]">
                      {item.label}
                    </span>
                    <span className="ml-auto shrink-0 pl-2 text-[10px] text-[color:var(--text-weaker)]">
                      {KIND_LABEL[item.kind]}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              // Own empty state: <CommandEmpty> keys off the internal query,
              // which this picker never uses (the filter is done above).
              <div className="py-6 text-center text-sm text-[color:var(--text-weaker)]">
                No matching references
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
