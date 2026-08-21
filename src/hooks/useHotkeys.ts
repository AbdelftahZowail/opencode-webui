import { useEffect, useRef } from "react";

const MODIFIERS = ["ctrl", "shift", "meta", "alt"] as const;
type Modifier = (typeof MODIFIERS)[number];

const ALIASES: Record<string, string> = {
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  super: "meta",
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

function normalizeKey(key: string): string {
  const k = key.trim().toLowerCase();
  return ALIASES[k] ?? k;
}

function parseCombo(combo: string): { mods: Set<Modifier>; key: string } {
  const mods = new Set<Modifier>();
  let key = "";
  for (const part of combo.split("+").map(normalizeKey)) {
    if ((MODIFIERS as readonly string[]).includes(part)) mods.add(part as Modifier);
    else key = part;
  }
  return { mods, key };
}

function matches(combo: string, e: KeyboardEvent): boolean {
  const { mods, key } = parseCombo(combo);
  if (!key || key !== normalizeKey(e.key)) return false;
  if (mods.has("ctrl") !== e.ctrlKey) return false;
  if (mods.has("shift") !== e.shiftKey) return false;
  if (mods.has("meta") !== e.metaKey) return false;
  if (mods.has("alt") !== e.altKey) return false;
  return true;
}

/**
 * Binds keydown on window for the given combo → handler map (e.g.
 * "ctrl+p", "ctrl+n", "escape"). Registered combos fire even while
 * focus is in an input/textarea/contenteditable; unregistered keys are
 * left untouched so typing is never blocked. Handlers receive the raw
 * KeyboardEvent so they can opt out per context.
 */
export function useHotkeys(map: Record<string, (e?: KeyboardEvent) => void>): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const combo = Object.keys(mapRef.current).find((c) => matches(c, e));
      const handler = combo ? mapRef.current[combo] : undefined;
      if (!handler) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
