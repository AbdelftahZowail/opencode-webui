/**
 * True on Apple platforms — used to render shortcut hints with the Mac
 * symbol (⌘F) instead of the cross-platform spelling (Ctrl+F). UA-based:
 * navigator.platform is deprecated and iPadOS masquerades as desktop
 * Safari, so match the family in one place.
 */
export const IS_MAC = /mac|iphone|ipad|ipod/i.test(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
);

/** Shortcut hint for "find/search", per platform: ⌘F vs Ctrl+F. */
export const SEARCH_KBD = IS_MAC ? "⌘F" : "Ctrl F";

/**
 * True when the primary input is touch (phones/tablets) — i.e. programmatic
 * focus would pop the on-screen keyboard without a user gesture. Media-query
 * based: iPadOS reports a Mac user agent, but "(pointer: coarse)" stays honest,
 * so this is more reliable than UA sniffing for the mobile case.
 */
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
