import { closeRunsPanel, getState, pendingRequests, revealSubagentComposer } from "../store";

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
