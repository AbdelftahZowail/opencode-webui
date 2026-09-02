import { closeRunsPanel, focusedPaneKey, getState, pendingRequests, revealSubagentComposer } from "../store";

/**
 * "Type anywhere" handoff: a printable keystroke pressed while keyboard
 * focus sits on a non-editable surface (messages list, sidebar, the runs
 * panel box…) belongs to the composer.
 *
 * When the textarea already exists, focus it and let the keydown take its
 * DEFAULT action — text insertion targets whatever is focused at the end of
 * dispatch, so the character lands natively (React onChange fires as if
 * typed). When the composer is not mounted (gated subagent page — its gate
 * strip replaces the input), reveal it and inject the character after it
 * mounts via the native value setter + a bubbling input event.
 */
export function handCharToComposer(ch: string, paneKey = "main") {
  // A pending permission/question/form REPLACES this session's composer;
  // typing must not fight the panel for the slot (or yank the gate around).
  const s = getState();
  if (s.currentSessionID && pendingRequests(s).some((r) => r.req.sessionID === s.currentSessionID)) {
    return;
  }
  // Any surface that REPLACES the composer in its slot (the runs panel)
  // has to make way first; a no-op when it is closed.
  closeRunsPanel();
  const existing = document.getElementById(`composer-input-${paneKey}`) as HTMLTextAreaElement | null;
  if (existing) {
    existing.focus({ preventScroll: true });
    return;
  }
  closeAndInject(ch, paneKey);
}

/**
 * Paste-anywhere handoff: a paste that would otherwise land on a non-editable
 * surface (message list, sidebar, body) is redirected into the composer.
 * Mirrors the type-anywhere handoff for parity — text is appended at the end,
 * image pastes are re-dispatched to the composer's own handler so staging works.
 */
export function setupPasteHandoff(): () => void {
  let redirecting = false;
  let lastComposer: HTMLTextAreaElement | null = null;

  const onFocusIn = (e: FocusEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.id?.startsWith("composer-input-")) lastComposer = t as HTMLTextAreaElement;
  };
  document.addEventListener("focusin", onFocusIn, true);

  const isEditable = (el: Element | null) =>
    !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || (el as HTMLElement).isContentEditable);

  const findComposer = (): HTMLTextAreaElement | null => {
    if (lastComposer && document.contains(lastComposer)) return lastComposer;
    // Prefer the focused pane's composer — split panes each have one.
    const paneKey = focusedPaneKey();
    const focused = document.getElementById(`composer-input-${paneKey}`) as HTMLTextAreaElement | null;
    if (focused) return focused;
    const main = document.getElementById("composer-input-main") as HTMLTextAreaElement | null;
    if (main) return main;
    const all = document.querySelectorAll('textarea[id^="composer-input-"]');
    for (const ta of all) if ((ta as HTMLElement).offsetParent !== null) return ta as HTMLTextAreaElement;
    return (all[0] as HTMLTextAreaElement | undefined) ?? null;
  };

  const onPaste = (e: ClipboardEvent) => {
    if (redirecting) return;
    if (isEditable(e.target as Element | null)) return;
    // Let dialogs/menus handle their own pastes.
    if (document.querySelector('[role="dialog"], [cmdk-root], [data-radix-popper-content-wrapper], [role="menu"]')) {
      // If an overlay input is not the active target, still let the paste go
      // to the overlay's focused element via normal flow — skip redirect.
      const active = document.activeElement as HTMLElement | null;
      if (active && isEditable(active)) return;
    }
    const ta = findComposer();
    if (!ta) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const hasFiles = dt.files && dt.files.length > 0;
    let text = "";
    try {
      text = dt.getData("text/plain") || "";
    } catch {
      text = "";
    }
    if (!hasFiles && !text) return;

    e.preventDefault();
    redirecting = true;
    try {
      // Dismiss anything that replaces the composer (runs panel).
      closeRunsPanel();
      ta.focus({ preventScroll: true });

      if (hasFiles) {
        try {
          const clone = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          });
          ta.dispatchEvent(clone);
        } catch {
          /* engine cannot clone — images won't stage */
        }
      }

      if (text) {
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, text);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (set) {
            set.call(ta, ta.value + text);
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            const n = ta.value.length;
            ta.setSelectionRange(n, n);
          }
        }
      }
    } finally {
      setTimeout(() => {
        redirecting = false;
      }, 0);
    }
  };

  document.addEventListener("paste", onPaste, true);
  return () => {
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("focusin", onFocusIn, true);
  };
}

/** Composer missing (gate up / panel slot swap): mount it, then inject. */
function closeAndInject(ch: string, paneKey: string) {
  let frames = 0;
  const step = () => {
    const el = document.getElementById(`composer-input-${paneKey}`) as HTMLTextAreaElement | null;
    if (!el) {
      // Gated subagent page: the gate strip has to come down first.
      if (frames++ === 2) revealSubagentComposer();
      if (frames < 30) requestAnimationFrame(step);
      return;
    }
    el.focus({ preventScroll: true });
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (set) {
      set.call(el, el.value + ch);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  };
  requestAnimationFrame(step);
}
