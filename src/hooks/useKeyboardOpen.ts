import { useEffect, useState } from "react";

/**
 * True while a text-entry element owns DOM focus — the signal for "the
 * mobile keyboard is (probably) open". Driven by window focusin/focusout so
 * every bottom-chrome owner (Conversation strips, Composer rows, App-level
 * activity strip/chip) reads the same value with no prop drilling or store
 * churn. Buttons/selects/checkboxes don't count — only elements that summon
 * the soft keyboard.
 */
function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  // Overlay search fields (the model picker's filter) opt out: they summon the
  // soft keyboard too, but treating them as "the message composer is typing"
  // collapsed the mobile composer chrome — hiding the picker's own trigger
  // mid-open, which on Android repositioned the anchored menu off-screen once
  // the keyboard resized the viewport.
  if (el.closest("[data-keyboard-ignore]")) return false;
  return (
    el.closest(
      'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]), [contenteditable="true"]',
    ) !== null
  );
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState<boolean>(() => isTextEntry(document.activeElement));
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      if (isTextEntry(e.target as Element | null)) setOpen(true);
    };
    const onOut = () => {
      // focusout fires before the next focusin — defer so focus hopping
      // between two inputs (textarea → form field) never flickers closed.
      requestAnimationFrame(() => {
        if (!isTextEntry(document.activeElement)) setOpen(false);
      });
    };
    window.addEventListener("focusin", onIn);
    window.addEventListener("focusout", onOut);
    return () => {
      window.removeEventListener("focusin", onIn);
      window.removeEventListener("focusout", onOut);
    };
  }, []);
  return open;
}
