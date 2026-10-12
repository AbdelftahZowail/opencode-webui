/**
 * Large-paste collapse for the Composer (parity R8).
 *
 * v2's prompt swaps a big paste for a short `[Pasted ~N lines]` placeholder in
 * the buffer and expands it back on send (`component/prompt/index.tsx`). The
 * placeholder stays literal while collapsed so a draft round-trips through
 * `saveDraft`, and the pasted bytes are kept alongside the draft (persisted
 * per session here) so a reload never silently sends the placeholder text.
 *
 * Pure helpers first; localStorage persistence last.
 */

/** A pasted block remembered while its placeholder sits in the draft. */
export interface PasteBlock {
  id: string;
  /** The full pasted text, restored on expand / send. */
  text: string;
  /** Line count the label reports. */
  lines: number;
}

/** Collapse a paste at/over either threshold. Kept low enough that a big
 *  paste is obviously collapsed, high enough that a few lines never are. */
export const PASTE_COLLAPSE_MIN_LINES = 8;
export const PASTE_COLLAPSE_MIN_CHARS = 800;

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/** True when a pasted string is big enough to collapse into a placeholder. */
export function shouldCollapsePaste(text: string): boolean {
  if (!text) return false;
  return countLines(text) >= PASTE_COLLAPSE_MIN_LINES || text.length >= PASTE_COLLAPSE_MIN_CHARS;
}

/** The visible placeholder for a paste of `lines` lines. */
export function pasteLabel(lines: number): string {
  return `[Pasted ~${lines} lines]`;
}

/** Build a remembered block (id is unique per paste). */
export function makePasteBlock(text: string): PasteBlock {
  return {
    id: `paste_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    lines: countLines(text),
  };
}

/** Replace the FIRST occurrence of a placeholder with its text. No-op when
 *  the token is absent (already expanded / removed). */
export function expandPlaceholder(draft: string, placeholder: string, text: string): string {
  const idx = draft.indexOf(placeholder);
  if (idx === -1) return draft;
  return draft.slice(0, idx) + text + draft.slice(idx + placeholder.length);
}

/** Remove the FIRST occurrence of a placeholder (drop without expanding). */
export function removePlaceholder(draft: string, placeholder: string): string {
  const idx = draft.indexOf(placeholder);
  if (idx === -1) return draft;
  return draft.slice(0, idx) + draft.slice(idx + placeholder.length);
}

/** Expand every remembered placeholder back to its full text (send-time). */
export function expandAllPastes(draft: string, blocks: PasteBlock[]): string {
  let out = draft;
  for (const block of blocks) out = expandPlaceholder(out, pasteLabel(block.lines), block.text);
  return out;
}

// ---------------------------------------------------------------------------
// Persistence — blocks ride with the per-session draft
// ---------------------------------------------------------------------------

const STORAGE_KEY = "webui.pasteBlocks";
const MAX_SESSIONS = 50;

type BySession = Record<string, PasteBlock[]>;

function isBlock(value: unknown): value is PasteBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  return (
    typeof block.id === "string" &&
    typeof block.text === "string" &&
    typeof block.lines === "number"
  );
}

function load(): BySession {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: BySession = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.filter(isBlock);
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: BySession): void {
  try {
    // Keep only the most recently written sessions (bounded storage).
    const kept = Object.entries(map)
      .filter(([, blocks]) => blocks.length > 0)
      .slice(-MAX_SESSIONS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable — collapsed pastes just don't survive a reload */
  }
}

export function loadPasteBlocks(sessionID: string): PasteBlock[] {
  return load()[sessionID] ?? [];
}

export function savePasteBlocks(sessionID: string, blocks: PasteBlock[]): void {
  const map = load();
  if (blocks.length > 0) map[sessionID] = blocks;
  else delete map[sessionID];
  write(map);
}

export function clearPasteBlocks(sessionID: string): void {
  const map = load();
  if (!(sessionID in map)) return;
  delete map[sessionID];
  write(map);
}
