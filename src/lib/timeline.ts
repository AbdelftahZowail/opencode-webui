/**
 * Timeline (R4) — pure helpers behind `TimelineDialog.tsx`.
 *
 * The dialog lists every *user* message newest-first with a relative time
 * footer (v2's `/timeline` / `session.timeline`). These helpers are free of
 * React and the store so the dialog stays presentational and the list logic
 * stays unit-testable.
 *
 * "User message" matches the transcript's own rule (`MessageItem`'s `isUser`):
 * `type === "user"`, excluding the client-only optimistic rows (`msg_local_*`)
 * and the draft placeholder (`__draft__`). Synthetic and compaction turns are
 * separate message types in our model, so filtering on `type` already drops
 * them exactly as v2 does.
 */

import type { MessageInfo, UserMessage } from "../api/types";

/** Minimal shape the helpers need from a user message. */
type UserLike = UserMessage;

/** True for a real, persisted user turn (the timeline's unit). */
export function isTimelineMessage(message: MessageInfo): message is UserLike {
  return (
    message.type === "user" &&
    !message.id.startsWith("msg_local_") &&
    !message.id.startsWith("__draft__")
  );
}

/**
 * The timeline's rows: every real user message, NEWEST FIRST. The engine's
 * order is preserved within the list; we only reverse it. Returns a fresh
 * array (never the caller's).
 */
export function userMessages(messages: MessageInfo[]): UserLike[] {
  const rows: UserLike[] = [];
  for (const message of messages) {
    if (isTimelineMessage(message)) rows.push(message);
  }
  rows.reverse();
  return rows;
}

/**
 * Compact relative-time footer ("just now", "5m ago", "3h ago", "2d ago",
 * then an absolute date once it is more than a week old). `now` is injectable
 * for deterministic tests; future timestamps (clock skew) clamp to "just now".
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: days >= 365 ? "numeric" : undefined,
  });
}

/** First line of a user message, whitespace-collapsed and length-capped. */
export function previewText(message: UserLike, max = 160): string {
  const firstLine = (message.text ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Number of attachments on a user message (rendered as a row hint). */
export function attachmentCount(message: UserLike): number {
  return message.files?.length ?? 0;
}

/** Clamp an index into `[0, count-1]`; `count === 0` yields 0. */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, index), count - 1);
}

/**
 * Move a selection by `delta`, WRAPPING at both ends (the TUI dialog-list
 * convention — same as the stash panel). `count === 0` keeps 0.
 */
export function moveSelection(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Flat index of a message id in the rows, or -1. */
export function indexOfMessage(rows: UserLike[], messageID: string): number {
  return rows.findIndex((row) => row.id === messageID);
}
