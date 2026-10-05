/**
 * Inline-preview controls — one session-local preference for whether `~~~`
 * fences render as live previews.
 *
 * SESSION-SCOPED ON PURPOSE: this lives in memory, not localStorage, so the
 * default is always ON on every load and a paused state never becomes a
 * permanent sticky decision a user forgets they made. The inline Pause control
 * (and the phone-only Settings › App switch) is the one place that pauses it;
 * the transcript simply follows.
 *
 * The store lives here (a small external store read via useSyncExternalStore
 * to match the codebase idiom) rather than in prefs.ts, which is contract
 * owned by another workstream.
 */
import { useSyncExternalStore } from "react";

let enabled = true;
const listeners = new Set<() => void>();

export function isMarkdownRenderingEnabled(): boolean {
  return enabled;
}

export function setMarkdownRendering(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const fn of listeners) fn();
}

export function subscribeMarkdownRendering(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): boolean {
  return enabled;
}

/** Live flag — a component re-renders when the pause toggle flips. */
export function useMarkdownRendering(): boolean {
  return useSyncExternalStore(subscribeMarkdownRendering, getSnapshot, () => true);
}
