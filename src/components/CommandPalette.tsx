import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, FilePlus2, FolderGit2, Palette } from "lucide-react";
import {
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

  const sortedSessions = [...sessions].sort((a, b) => b.time.updated - a.time.updated);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
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
