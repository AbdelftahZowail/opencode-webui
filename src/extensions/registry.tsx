import { type ReactNode, Component, useSyncExternalStore } from "react";
import type { MessageInfo, ToolPart } from "../api/types";
import { enabled } from "../../ui-extensions/config";

/**
 * The extension registry — the ONLY stable contract between the app and
 * ui-extensions. Kinds are versioned here; extensions register against them.
 * See ui-extensions/README.md for the authoring guide.
 *
 * Kinds (every one gated per-id by `enabled` in config.ts):
 *  - "region"              — markup rendered wherever a `<Slot region="…"/>`
 *                            marker sits; session/message/part ctx flows in.
 *  - "command"             — command-palette entries (title + run, order).
 *  - "slash"               — UI-only slash entry for Composer `/name` (local run, not engine; engine slash via engine plugin + GET /api/command).
 *  - "message.decoration"  — extra UI attached to a transcript message.
 *  - "message.part"        — injection after each text/tool/reasoning part.
 *  - "message"             — full replacement for a message type (like
 *                            tool.renderer for tools); first non-null render
 *                            wins, fallback is core renderMessageBody.
 *  - "hook"                — intercept/observe (known: store.dispatch,
 *                            session.prompt, message.render; event is open string so new seams need no registry bump).
 *  - "page"                — a full page; App routes `/ext/{id}` implicitly
 *                            for every registered page (no path is stored).
 *  - "tool.renderer"       — custom card for a specific tool name.
 *  - "settings"            — titled section inside Settings › Extensions.
 */

/** Context handed to region/command/page/slash renderers; all fields optional. */
export interface ExtensionContext {
  sessionID?: string;
  messageID?: string;
  part?: ToolPart;
}

/** Context for a message decoration: the id plus the message itself. */
export interface MessageDecorationCtx {
  messageID: string;
  message: MessageInfo;
}

export interface RegionExtension {
  kind: "region";
  id: string;
  region: string;
  render: (ctx: ExtensionContext) => ReactNode;
}

export interface CommandExtension {
  kind: "command";
  id: string;
  title: string;
  run: (ctx: ExtensionContext) => void;
  order?: number;
  keybind?: string;
}

export interface SlashExtension {
  kind: "slash";
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  run: (args: string, ctx: ExtensionContext) => void | Promise<void>;
}

export interface MessagePartDecorationExtension {
  kind: "message.part";
  id: string;
  render: (ctx: { messageID: string; message: MessageInfo; part: ToolPart; partIndex: number }) => ReactNode | null;
}

export interface ContextMenuExtension {
  kind: "contextMenu";
  id: string;
  target: "message" | "session" | "file";
  label: string;
  run: (ctx: ExtensionContext) => void;
  order?: number;
}

export interface HookExtension {
  kind: "hook";
  id: string;
  event: string;
  handler: (ctx: Record<string, unknown>, next: () => void) => void | Promise<void>;
}

export interface MessageDecorationExtension {
  kind: "message.decoration";
  id: string;
  render: (ctx: MessageDecorationCtx) => ReactNode | null;
}

/**
 * A full page. Its route is DERIVED, never stored: App serves `/ext/{id}`
 * for every enabled page, so ids double as URL slugs.
 */
export interface PageExt {
  kind: "page";
  id: string;
  title: string;
  description?: string;
  render: (ctx: ExtensionContext) => ReactNode;
}

/** A titled section inside the app's Settings page ("settings" kind). */
export interface SettingsExtension {
  kind: "settings";
  id: string;
  title: string;
  description?: string;
  render: () => ReactNode;
}

export interface ToolRendererExtension {
  kind: "tool.renderer";
  id: string;
  toolName: string;
  render: (part: ToolPart) => ReactNode;
}

export interface MessageExtension {
  kind: "message";
  id: string;
  /** Message type this renderer handles; "*" matches any type. Defaults to "*". */
  type?: MessageInfo["type"] | "*";
  render: (ctx: { message: MessageInfo; sessionID?: string }) => ReactNode | null;
}

/** What register() accepts: first-class kinds only (no legacy slot shapes). */
export type ExtInput =
  | { kind: "region"; id: string; region: string; render: (ctx: ExtensionContext) => ReactNode }
  | { kind: "command"; id: string; title: string; run: (ctx: ExtensionContext) => void; order?: number; keybind?: string }
  | { kind: "slash"; id: string; name: string; description?: string; aliases?: string[]; run: (args: string, ctx: ExtensionContext) => void | Promise<void> }
  | { kind: "message.decoration"; id: string; render: (ctx: MessageDecorationCtx) => ReactNode | null }
  | { kind: "message.part"; id: string; render: (ctx: { messageID: string; message: MessageInfo; part: ToolPart; partIndex: number }) => ReactNode | null }
  | { kind: "message"; id: string; type?: MessageInfo["type"] | "*"; render: (ctx: { message: MessageInfo; sessionID?: string }) => ReactNode | null }
  | { kind: "contextMenu"; id: string; target: "message" | "session" | "file"; label: string; run: (ctx: ExtensionContext) => void; order?: number }
  | { kind: "hook"; id: string; event: string; handler: (ctx: Record<string, unknown>, next: () => void) => void | Promise<void> }
  | { kind: "page"; id: string; title: string; description?: string; render: (ctx: ExtensionContext) => ReactNode }
  | { kind: "settings"; id: string; title: string; description?: string; render: () => ReactNode }
  | { kind: "tool.renderer"; id: string; toolName: string; render: (part: ToolPart) => ReactNode };

/** Internal storage: every input normalized into one discriminated union. */
type StoredExt =
  | RegionExtension
  | CommandExtension
  | SlashExtension
  | MessageDecorationExtension
  | MessagePartDecorationExtension
  | MessageExtension
  | ContextMenuExtension
  | HookExtension
  | PageExt
  | SettingsExtension
  | ToolRendererExtension;

const registry: StoredExt[] = [];
const enabledSet = new Set(enabled);

/**
 * Gating check with ANCESTRY: "dev-sandbox.header" is on when its owner id
 * "dev-sandbox" is enabled. One config entry (or one runtime plugin id)
 * therefore gates every registration the extension made under it.
 */
function isIdEnabled(id: string): boolean {
  if (enabledSet.has(id)) return true;
  let cut = id.lastIndexOf(".");
  while (cut > 0) {
    const parent = id.slice(0, cut);
    if (enabledSet.has(parent)) return true;
    cut = parent.lastIndexOf(".");
  }
  return false;
}

/**
 * Registry mutations are observable so extension hot updates repaint
 * WITHOUT a page reload: an edited (self-accepting) extension module
 * re-registers with the same id, `register()` swaps it in and bumps the
 * version, and every mounted Slot re-reads the fresh render fns.
 */
let registryVersion = 0;
const listeners = new Set<() => void>();

export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyRegistryChange() {
  registryVersion++;
  for (const listener of listeners) listener();
}

/**
 * Drops registrations whose ids are missing from `seenIds` — called after
 * extension re-discovery so a DELETED folder's slot disappears without a
 * page reload. Only ever fed ids harvested from live extension modules.
 * Id-keyed by design, so it prunes every kind uniformly — no change needed.
 */
export function pruneExtensions(seenIds: Set<string>) {
  let removed = false;
  for (let i = registry.length - 1; i >= 0; i--) {
    if (!seenIds.has(registry[i]!.id)) {
      registry.splice(i, 1);
      removed = true;
    }
  }
  if (removed) notifyRegistryChange();
}

/**
 * Runtime (plugin-shipped) extensions discover their ids only after boot —
 * the enabled set is seeded from the static config list, so the loader
 * allow-lists discovered ids here before importing their bundles.
 */
export function enableRuntimeIds(ids: string[]) {
  for (const id of ids) enabledSet.add(id);
}

/** Turn runtime ids off: revoke gating AND unregister everything they added. */
export function disableRuntimeIds(ids: string[]) {
  const drop = new Set(ids);
  for (const id of drop) enabledSet.delete(id);
  let removed = false;
  for (let i = registry.length - 1; i >= 0; i--) {
    if (!isIdEnabled(registry[i]!.id)) {
      registry.splice(i, 1);
      removed = true;
    }
  }
  if (removed) notifyRegistryChange();
}

/** Every id currently holding registrations (built-in + runtime). */
export function getRegisteredIds(): string[] {
  return registry.map((e) => e.id);
}

/** Route App implicitly serves for a page — derived from its id, never stored. */
function pageRoute(id: string): string {
  return `/ext/${id}`;
}

export function register(ext: ExtInput) {
  const existing = registry.findIndex((e) => e.id === ext.id);
  if (existing !== -1) {
    registry[existing] = ext as StoredExt;
    notifyRegistryChange();
    return;
  }
  if (ext.kind === "page") {
    const route = pageRoute(ext.id);
    const clash = registry.find(
      (e) => e.kind === "page" && e.id !== ext.id && pageRoute(e.id) === route,
    );
    if (clash) {
      console.warn(
        `[extensions] page "${ext.id}" rejected: route ${route} is already taken by page "${clash.id}"`,
      );
      return;
    }
  }
  if (ext.kind === "slash") {
    const name = ext.name.toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(name)) {
      console.warn(`[extensions] slash "${ext.id}" rejected: name "${ext.name}" must match /^[a-z0-9_-]+$/`);
      return;
    }
  }
  registry.push(ext as StoredExt);
  notifyRegistryChange();
}

export function getRegions(
  region: string,
): { id: string; render: (ctx: ExtensionContext) => ReactNode }[] {
  return registry.filter(
    (e): e is RegionExtension => e.kind === "region" && e.region === region && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

const DEFAULT_COMMAND_ORDER = 100;

/** Sorted by order ?? 100, then title; ties keep registration order (stable sort). */
export function getCommands(): { id: string; title: string; run: (ctx: ExtensionContext) => void }[] {
  return registry
    .filter((e): e is CommandExtension => e.kind === "command" && (enabledSet.has(e.id) || isIdEnabled(e.id)))
    .sort(
      (a, b) =>
        (a.order ?? DEFAULT_COMMAND_ORDER) - (b.order ?? DEFAULT_COMMAND_ORDER) ||
        a.title.localeCompare(b.title),
    );
}

export function getSlashCommands(): SlashExtension[] {
  return registry.filter(
    (e): e is SlashExtension => e.kind === "slash" && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

export function getMessageDecorations(): {
  id: string;
  render: (ctx: MessageDecorationCtx) => ReactNode | null;
}[] {
  return registry.filter(
    (e): e is MessageDecorationExtension => e.kind === "message.decoration" && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

export function getPages(): {
  id: string;
  title: string;
  description?: string;
  render: (ctx: ExtensionContext) => ReactNode;
}[] {
  return registry.filter((e): e is PageExt => e.kind === "page" && (enabledSet.has(e.id) || isIdEnabled(e.id)));
}

/** Settings-page sections contributed by extensions ("settings" kind). */
export function getSettings(): {
  id: string;
  title: string;
  description?: string;
  render: () => ReactNode;
}[] {
  return registry.filter(
    (e): e is SettingsExtension => e.kind === "settings" && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

export function getMessagePartDecorations(): {
  id: string;
  render: (ctx: { messageID: string; message: MessageInfo; part: ToolPart; partIndex: number }) => ReactNode | null;
}[] {
  return registry.filter(
    (e): e is MessagePartDecorationExtension => e.kind === "message.part" && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

export function getContextMenus(target: ContextMenuExtension["target"]): {
  id: string;
  label: string;
  run: (ctx: ExtensionContext) => void;
}[] {
  return registry
    .filter((e): e is ContextMenuExtension => e.kind === "contextMenu" && e.target === target && (enabledSet.has(e.id) || isIdEnabled(e.id)))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}

export function getHooks(event: string): HookExtension[] {
  return registry.filter((e): e is HookExtension => e.kind === "hook" && e.event === event && (enabledSet.has(e.id) || isIdEnabled(e.id)));
}

export function getPage(id: string): PageExt | undefined {
  return registry.find((e): e is PageExt => e.kind === "page" && e.id === id && (enabledSet.has(e.id) || isIdEnabled(e.id)));
}

export function getToolRenderer(toolName: string): ToolRendererExtension | undefined {
  return registry.find(
    (e): e is ToolRendererExtension =>
      e.kind === "tool.renderer" && e.toolName === toolName && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

export function getMessageRenderer(type: MessageInfo["type"]): MessageExtension | undefined {
  const exact = registry.find(
    (e): e is MessageExtension => e.kind === "message" && (e.type ?? "*") === type && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
  if (exact) return exact;
  return registry.find(
    (e): e is MessageExtension => e.kind === "message" && (e.type ?? "*") === "*" && (enabledSet.has(e.id) || isIdEnabled(e.id)),
  );
}

/**
 * The universal region marker: renders every "region" extension registered
 * for `region`, passing session/message/part ctx through. Renders nothing
 * (or `fallback`) when the region has no enabled extensions. Tracks registry
 * swaps so extension hot updates repaint without any reload.
 */
export function Slot(props: {
  region: string;
  sessionID?: string;
  messageID?: string;
  part?: ToolPart;
  fallback?: ReactNode;
}): ReactNode {
  useSyncExternalStore(subscribeRegistry, () => registryVersion);
  const items = getRegions(props.region);
  if (items.length === 0) return props.fallback ?? null;
  const ctx: ExtensionContext = {
    sessionID: props.sessionID,
    messageID: props.messageID,
    part: props.part,
  };
  return (
    <>
      {items.map((e) => (
        <SlotErrorBoundary key={e.id} id={e.id}>
          <div>{e.render(ctx)}</div>
        </SlotErrorBoundary>
      ))}
    </>
  );
}

/**
 * One broken extension must not blank the app region it renders into —
 * crash isolation is per slot item; the rest of the slot keeps working.
 */
class SlotErrorBoundary extends Component<
  { children: ReactNode; id: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error(`[extensions] slot item "${this.props.id}" crashed:`, err);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
