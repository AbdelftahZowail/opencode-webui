import { type ReactNode } from "react";
import type { ToolPart } from "../api/types";
import { enabled } from "../../ui-extensions/config";

/**
 * The extension registry — the ONLY stable contract between the app and
 * ui-extensions. Slot types are versioned here; extensions register against
 * them. See ui-extensions/README.md for the authoring guide.
 */

export type RenderSlot = "sidebar" | "footer" | "composer.replace";
export type Slot = RenderSlot | "tool.renderer";

interface SlotExtension {
  id: string;
  slot: RenderSlot;
  render: () => ReactNode;
}

interface ToolRendererExtension {
  id: string;
  slot: "tool.renderer";
  toolName: string;
  render: (part: ToolPart) => ReactNode;
}

export type Extension = SlotExtension | ToolRendererExtension;

const registry: Extension[] = [];
const enabledSet = new Set(enabled);

export function register(ext: Extension) {
  if (registry.some((e) => e.id === ext.id)) {
    console.warn(`[extensions] duplicate id "${ext.id}" ignored`);
    return;
  }
  registry.push(ext);
}

export function getSlot(slot: RenderSlot): SlotExtension[] {
  return registry.filter((e): e is SlotExtension => e.slot === slot && enabledSet.has(e.id));
}

export function getToolRenderer(toolName: string): ToolRendererExtension | undefined {
  return registry.find(
    (e): e is ToolRendererExtension =>
      e.slot === "tool.renderer" && e.toolName === toolName && enabledSet.has(e.id),
  );
}

/** Renders the extension at a slot, falling back to `fallback` when none. */
export function SlotOutlet({ slot, fallback }: { slot: RenderSlot; fallback?: ReactNode }) {
  const items = getSlot(slot);
  if (items.length === 0) return fallback ?? null;
  return <>{items.map((e) => <div key={e.id}>{e.render()}</div>)}</>;
}
