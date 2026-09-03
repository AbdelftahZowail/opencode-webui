import { useEffect } from "react";
import { getContributions, subscribeRegistry, type PaletteContribution } from "../extensions/registry";
import { getState } from "../store";

function parseKeybind(str: string): { ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; key: string } {
  const parts = str
    .toLowerCase()
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const p of parts) {
    if (p === "ctrl" || p === "control") ctrl = true;
    else if (p === "meta" || p === "cmd" || p === "command" || p === "super") meta = true;
    else if (p === "shift") shift = true;
    else if (p === "alt" || p === "option") alt = true;
    else key = p;
  }
  return { ctrl, meta, shift, alt, key };
}

function matchesBinding(binding: string, e: KeyboardEvent): boolean {
  const b = parseKeybind(binding);
  if (!b.key) return false;
  if (b.ctrl !== e.ctrlKey) return false;
  if (b.meta !== e.metaKey) return false;
  if (b.shift !== e.shiftKey) return false;
  if (b.alt !== e.altKey) return false;
  return e.key.toLowerCase() === b.key.toLowerCase();
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.closest?.("input, textarea, select, [contenteditable=true]")) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function CommandKeybinds() {
  useEffect(() => {
    let commands = getContributions<PaletteContribution>("palette");

    const refresh = () => {
      commands = getContributions<PaletteContribution>("palette");
    };

    const unsub = subscribeRegistry(refresh);

    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (isEditableTarget(e.target)) return;
      // Don't hijack when a dialog/menu/popover owns the keyboard
      if (document.querySelector('[role="dialog"], [cmdk-root], [data-radix-popper-content-wrapper], [role="menu"], [role="listbox"]')) {
        return;
      }
      for (const c of commands) {
        const kb = c.item.keybind;
        if (!kb) continue;
        if (matchesBinding(kb, e)) {
          e.preventDefault();
          try {
            const sid = getState().currentSessionID ?? undefined;
            c.item.run({ sessionID: sid });
          } catch (err) {
            console.error(`[extensions] command "${c.id}" keybind failed:`, err);
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => {
      unsub();
      window.removeEventListener("keydown", handler);
    };
  }, []);

  return null;
}
