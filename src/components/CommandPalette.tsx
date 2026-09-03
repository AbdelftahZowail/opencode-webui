import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, FilePlus2, FolderGit2, Palette, Puzzle } from "lucide-react";
import { getContributions, type PaletteContribution } from "../extensions/registry";
import {
  commandMove,
  commandSelectActive,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command";
import { getPrefs, setPref, subscribePrefs, type Prefs } from "../prefs";
import { newSession, selectSession, useStore } from "../store";
import { useHotkeys } from "../hooks/useHotkeys";

interface ThemeEntry {
  id: string;
  label: string;
}

interface ThemesModule {
  THEMES?: { id: string; label: string; vars: Record<string, string> }[];
  listThemes?: () => ThemeEntry[];
  applyTheme?: (id: string) => void;
  getTheme?: () => string | null;
}

function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(() => setPrefs(getPrefs())), []);
  return prefs;
}

// TODO(W5): switch to a static import once src/theme/themes.ts lands; the
// guarded dynamic import keeps the build green while the file is absent.
const THEMES_URL = "../theme/themes";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const sessions = useStore((s) => s.sessions);
  const currentSessionID = useStore((s) => s.currentSessionID);
  const prefs = usePrefs();
  const [themes, setThemes] = useState<{
    list: ThemeEntry[];
    apply: (id: string) => void;
    current: string | null;
  } | null>(null);

  useHotkeys({
    "ctrl+p": () => setOpen((v) => !v),
    escape: () => setOpen(false),
  });

  useEffect(() => {
    let cancelled = false;
    import(/* @vite-ignore */ THEMES_URL)
      .then((mod) => {
        if (cancelled) return;
        const m = mod as ThemesModule;
        if (typeof m.applyTheme !== "function") return;
        const list = m.listThemes
          ? m.listThemes()
          : (m.THEMES ?? []).map((t) => ({ id: t.id, label: t.label }));
        if (!list.length) return;
        setThemes({ list, apply: m.applyTheme, current: m.getTheme?.() ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Child/subagent sessions are managed inside their parent conversation,
  // not offered as top-level navigation.
  const sortedSessions = [...sessions]
    .filter((s) => !s.parentID)
    .sort((a, b) => b.time.updated - a.time.updated);

  // Extension commands are read at render time (re-read on every palette
  // open); no subscription/polling — a mid-open registry change self-corrects
  // on the next open.
  const extensionCommands = getContributions<PaletteContribution>("palette");

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Type a command or search…"
        onKeyDown={(e) => {
          // The vendored Command no longer listens on document; the palette
          // drives its own menu from the input's keydown (arrows move,
          // Enter selects — Tab intentionally closes via the dialog).
          if (e.key === "ArrowDown") {
            e.preventDefault();
            commandMove(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            commandMove(-1);
          } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            commandSelectActive();
          }
        }}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              void newSession();
            }}
          >
            <FilePlus2 />
            <span>New session</span>
            <CommandShortcut>Ctrl N</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() => setPref("showReasoning", !prefs.showReasoning)}
          >
            {prefs.showReasoning ? <EyeOff /> : <Eye />}
            <span>{prefs.showReasoning ? "Hide" : "Show"} thinking</span>
          </CommandItem>
          <CommandItem
            onSelect={() => setPref("showToolDetails", !prefs.showToolDetails)}
          >
            {prefs.showToolDetails ? <EyeOff /> : <Eye />}
            <span>{prefs.showToolDetails ? "Hide" : "Show"} tool details</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Sessions">
          {sortedSessions.length === 0 && (
            <CommandItem disabled>
              <FolderGit2 />
              <span>No sessions yet</span>
            </CommandItem>
          )}
          {sortedSessions.map((s) => (
            <CommandItem
              key={s.id}
              value={`${s.title ?? "Untitled session"} ${s.id}`}
              onSelect={() => {
                setOpen(false);
                void selectSession(s.id);
              }}
            >
              <FolderGit2 />
              <span className="truncate">{s.title ?? "Untitled session"}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {extensionCommands.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Extension commands">
              {extensionCommands.map((c) => {
                const kb = c.item.keybind;
                return (
                  <CommandItem
                    key={c.id}
                    // Explicit value so the query matches BOTH title and id
                    // (text content alone only carries the title).
                    value={`${c.item.title} ${c.id} ${kb ?? ""}`}
                    onSelect={() => {
                      setOpen(false);
                      try {
                        c.item.run({ sessionID: currentSessionID ?? undefined });
                      } catch (err) {
                        console.error("[extensions] command failed:", err);
                      }
                    }}
                  >
                    <Puzzle />
                    <span className="truncate">{c.item.title}</span>
                    {kb ? <CommandShortcut>{kb}</CommandShortcut> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
        {themes && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Themes">
              {themes.list.map((t) => (
                <CommandItem
                  key={t.id}
                  onSelect={() => themes.apply(t.id)}
                >
                  <Palette />
                  <span>{t.label}</span>
                  {themes.current === t.id && (
                    <Check className="ml-auto size-4 opacity-100" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
