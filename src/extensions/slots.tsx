import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  TargetErrorBoundary,
  getContributions,
  subscribeRegistry,
} from "./registry";

/**
 * Thin slots — roadmap item 6.
 *
 * A slot is PLACEMENT, not identity: a named insertion point where any
 * extension contributes UI through the EXISTING `contribute` kind under the
 * collection id `"slot:<slotID>"`. No new registry kind, no "regions":
 * targets render a component chain (a unit with identity); slots render
 * contributions (a place to put things).
 *
 * The slot id registry below is versioned contract (§5.3): renaming or moving
 * an id is a deliberate version bump + migration note, never a silent break.
 * The stamping site carries `data-oc-slot="<id>"` — a stable markup anchor for
 * the DOM stratum, likewise versioned.
 */

/** One contribution to a slot. Sorted by `order` (lower first), then id. */
export interface SlotContribution {
  render: (ctx: { sessionID?: string | null }) => ReactNode | null;
}

/**
 * The known slot ids — the versioned registry. Add ids here (and the matching
 * `<Slot id="…"/>` stamp) in a release; never reuse or rename an id silently.
 */
export const SLOT_IDS = [
  "conversation.header.actions",
  "conversation.empty",
  "composer.above",
  "composer.actions",
  "sidebar.header.actions",
] as const;

export type SlotID = (typeof SLOT_IDS)[number];

/** Repaint hook: registry bumps re-render every mounted Slot (same pattern
 * as App/Sidebar/MessageItem — the registry exposes no version snapshot). */
function useSlotRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRegistry(() => setVersion((v) => v + 1)), []);
  return version;
}

/**
 * Renders one extension's contribution. Existing as its own component (rather
 * than calling `render` inline) is what makes `TargetErrorBoundary` able to
 * catch a throwing render — the call happens during THIS component's render,
 * inside the boundary.
 */
function SlotContributionView({
  contribution,
  sessionID,
}: {
  contribution: SlotContribution;
  sessionID?: string | null;
}) {
  return <>{contribution.render({ sessionID })}</>;
}

/**
 * Evaluate a slot to a node. Reads `slot:<id>` contributions (already sorted
 * lower-order-first), renders each crash-isolated, and stamps the wrapper with
 * `data-oc-slot` for the DOM stratum. Returns `null` when nothing is
 * contributed — no empty wrapper.
 */
export function Slot(props: { id: string; sessionID?: string | null }): ReactNode {
  const version = useSlotRegistryVersion();
  const { id, sessionID } = props;
  const items = useMemo(
    () => getContributions<SlotContribution>(`slot:${id}`),
    [id, version],
  );
  if (items.length === 0) return null;
  return (
    <span data-oc-slot={id} className="contents">
      {items.map((c) => (
        <TargetErrorBoundary key={c.id} id={`slot:${id}#${c.id}`}>
          <SlotContributionView contribution={c.item} sessionID={sessionID} />
        </TargetErrorBoundary>
      ))}
    </span>
  );
}
