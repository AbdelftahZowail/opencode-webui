/**
 * Shared window event names for one-shot UI requests that live outside the
 * store (a control in one subtree asks an app-level overlay in another to
 * open). Kept here so producers and consumers can't drift on the string.
 */

/** Open the global session/message search panel. */
export const OPEN_SEARCH_EVENT = "webui:open-search";
