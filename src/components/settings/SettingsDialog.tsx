import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Blocks, ChevronLeft, ChevronRight, Puzzle, ShieldCheck, Smartphone, XIcon } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Spinner } from "../ui";
import { registerPoller } from "../../lib/scheduler";
import { useIsPhone } from "../../hooks/useIsPhone";
import { getContributions, subscribeRegistry, type SettingsContribution } from "../../extensions/registry";
import { parseManifestContract, type SettingField } from "../../extensions/manifest";
import {
  registerExtensionSchema,
  resolvedExtensionSettings,
  setExtensionSetting,
  subscribeExtensionSettings,
} from "../../lib/extSettings";
import {
  getExtensionDiagnostics,
  subscribeExtensionDiagnostics,
} from "../../lib/extensionDiagnostics";
import { AccessSection } from "./AccessSection";
import { AppSection } from "./AppSection";
import { PluginsSection } from "./PluginsSection";
import { Empty, SectionHeader, inputCls } from "./shared";
import { checkPlugins, loadPlugins, updatePlugins, useStore } from "../../store";

let openRequest: ((section?: string) => void) | null = null;

export function openSettings(section?: string) {
  openRequest?.(section);
}

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-3xl h-[min(84vh,660px)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/**
 * Single-row tab strip: swipe-scroll on touch, edge chevrons on desktop.
 * Chevrons render only while there is overflow in that direction.
 */
function TabRail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    setMore({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };
  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const nudge = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * 180, behavior: "smooth" });
  const chevCls =
    "absolute top-1/2 z-10 hidden size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] text-[var(--text-weak)] shadow-sm hover:text-[var(--text-strong)] md:inline-flex";
  return (
    <div className="relative mb-2 min-w-0">
      {more.left && (
        <button
          type="button"
          aria-label="Scroll tabs left"
          onClick={() => nudge(-1)}
          className={`${chevCls} left-0.5`}
        >
          <ChevronLeft className="size-3.5" />
        </button>
      )}
      <div
        ref={ref}
        onScroll={update}
        className="no-scrollbar flex overflow-x-auto rounded-md bg-[var(--surface-base)] p-1"
      >
        <TabsList className="w-max gap-1 bg-transparent p-0 [&>*]:shrink-0">{children}</TabsList>
      </div>
      {more.right && (
        <button
          type="button"
          aria-label="Scroll tabs right"
          onClick={() => nudge(1)}
          className={`${chevCls} right-0.5`}
        >
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("extensions");
  // “app only shows on phone”: the App tab is phone-only — install/tile
  // controls are meaningless on a desktop browser.
  const phone = useIsPhone();
  const tabs = useMemo(
    () => [
      { id: "extensions", label: "Extensions", icon: Blocks },
      { id: "plugins", label: "Plugins", icon: Puzzle },
      { id: "security", label: "Security", icon: ShieldCheck },
      ...(phone ? [{ id: "app", label: "App", icon: Smartphone }] : []),
    ],
    [phone],
  );
  const valid = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs]);

  useEffect(() => {
    openRequest = (section) => {
      setTab(section && valid.has(section) ? section : "extensions");
      setOpen(true);
    };
    return () => {
      openRequest = null;
    };
  }, [valid]);

  // A device that switches to desktop while the phone-only tab is open must
  // not be left on a tab with no trigger.
  useEffect(() => {
    if (!valid.has(tab)) setTab("extensions");
  }, [valid, tab]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTab("extensions");
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader className="pr-8">
            <DialogTitle>Settings</DialogTitle>
            <p className="text-xs text-[var(--text-weaker)]">
              Extensions · plugins · security{phone ? " · app" : ""}
            </p>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 min-w-0 flex-col">
            <TabRail>
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-7 gap-1.5 rounded px-2 text-xs">
                  <t.icon className="size-3.5" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabRail>
            <ScrollArea className="min-h-0 flex-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-3">
              <TabsContent value="extensions">
                <ExtensionsSection />
              </TabsContent>
              <TabsContent value="plugins">
                <PluginsTab />
              </TabsContent>
              <TabsContent value="security">
                <AccessSection />
              </TabsContent>
              {phone && (
                <TabsContent value="app">
                  <AppSection />
                </TabsContent>
              )}
            </ScrollArea>
          </Tabs>

          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

/** One runtime (folder) extension as served by GET /api/webui/extensions. */
interface RuntimeExtensionInfo {
  id: string;
  url?: string;
  domUrl?: string;
  source?: string;
  origin?: "user" | "project" | "shipped";
  /** manifest.json display fields. */
  name?: string;
  description?: string;
  /** manifest.json `settings` — the declared schema (roadmap 5). */
  settings?: unknown;
  /** manifest.json `requires` — the checkable contract (roadmap 8). */
  requires?: unknown;
  /** manifest.json `capabilities` — declared metadata (roadmap 8). */
  capabilities?: unknown;
  /** manifest.json `disabled: true` — paused, never bundled or imported. */
  disabled?: boolean;
}

/**
 * Freshness for late/hot-swapped extension registrations — same local-counter
 * pattern as MessageItem's useRegistryVersion: the registry has no exported
 * version snapshot to read via useSyncExternalStore.
 */
function useRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRegistry(() => setVersion((v) => v + 1)), []);
  return version;
}

/** One control for a manifest-declared setting, bound to the per-id store. */
function SettingFieldControl({
  id,
  field,
  value,
}: {
  id: string;
  field: SettingField;
  value: unknown;
}) {
  if (field.type === "boolean") {
    return (
      <Switch
        checked={value === true}
        onCheckedChange={(checked) => setExtensionSetting(id, field.key, checked)}
      />
    );
  }
  if (field.type === "enum") {
    return (
      <select
        className={inputCls}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => setExtensionSetting(id, field.key, e.target.value)}
      >
        {field.options?.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "number") {
    return (
      <div className="w-28">
        <input
          type="number"
          className={inputCls}
          value={typeof value === "number" ? value : ""}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setExtensionSetting(id, field.key, n);
          }}
        />
      </div>
    );
  }
  return (
    <input
      className={inputCls}
      value={typeof value === "string" ? value : ""}
      placeholder={field.placeholder}
      onChange={(e) => setExtensionSetting(id, field.key, e.target.value)}
    />
  );
}

/**
 * Manifest-declared settings for one extension (roadmap 5): core renders the
 * declared schema — the extension ships no settings component or storage.
 * Re-renders on value changes; writes go through the per-id settings store.
 */
function DeclaredSettingsFields({ id, rawSchema }: { id: string; rawSchema: unknown }) {
  const schema = useMemo(
    () => parseManifestContract(rawSchema, undefined).settings ?? [],
    [rawSchema],
  );
  const [, force] = useState(0);
  useEffect(() => {
    // Mirror the schema into the registry the extension reads, so ctx.settings
    // resolves the same defaults even before the browser loader syncs it.
    if (schema.length > 0) registerExtensionSchema(id, schema);
  }, [id, schema]);
  useEffect(() => subscribeExtensionSettings(id, () => force((v) => v + 1)), [id]);
  if (schema.length === 0) return null;
  const values = resolvedExtensionSettings(id);
  return (
    <div className="space-y-2">
      {schema.map((field) => (
        <div key={field.key} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] text-[var(--text-strong)]">{field.title}</div>
            {field.description && (
              <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">{field.description}</p>
            )}
          </div>
          <div className="shrink-0">
            <SettingFieldControl id={id} field={field} value={values[field.key]} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Declared `requires` + live diagnostics for one extension (roadmap 8): a
 * reference that can't be satisfied is a visible, actionable line instead of a
 * silently blank spot.
 */
function ExtensionContract({ info }: { info: RuntimeExtensionInfo }) {
  const [, force] = useState(0);
  useEffect(() => subscribeExtensionDiagnostics(() => force((v) => v + 1)), []);
  const diagnostics = getExtensionDiagnostics(info.id);
  const requires = useMemo(
    () => parseManifestContract(undefined, info.requires).requires,
    [info.requires],
  );
  const bits: string[] = [];
  if (requires?.api !== undefined) bits.push(`api v${requires.api}`);
  if (requires?.targets?.length) bits.push(`targets: ${requires.targets.join(", ")}`);
  if (requires?.slots?.length) bits.push(`slots: ${requires.slots.join(", ")}`);
  if (requires?.services?.length) bits.push(`services: ${requires.services.join(", ")}`);
  if (bits.length === 0 && diagnostics.length === 0) return null;
  return (
    <div className="space-y-1">
      {bits.length > 0 && (
        <p className="font-mono text-[10px] text-[var(--text-weaker)]">requires {bits.join(" · ")}</p>
      )}
      {diagnostics.map((d, i) => (
        <p key={i} className="text-[11px] text-[var(--surface-warning-strong)]">
          ⚠ {d.message}
        </p>
      ))}
    </div>
  );
}

/**
 * Settings › Plugins. Thin store-connected host so the section itself stays
 * presentational: the catalog + action state live in the store (the plugin
 * actions are side effects and belong there), and the section just renders.
 */
function PluginsTab() {
  const plugins = useStore((s) => s.plugins);
  const busy = useStore((s) => s.pluginsBusy);
  const error = useStore((s) => s.pluginsError);
  useEffect(() => {
    void loadPlugins();
  }, []);
  return (
    <PluginsSection
      plugins={plugins ?? []}
      busy={busy}
      error={error}
      onCheck={(target) => void checkPlugins(target)}
      onUpdate={(targets) => void updatePlugins(targets)}
    />
  );
}

/**
 * Settings › Extensions: every installed extension as one card — display
 * name/description, origin, an on/off switch, and any settings that extension
 * contributes rendered IN its own section. Gating is owned by the folder:
 * the switch edits its manifest `disabled` flag (a user-level shadow for
 * shipped ids) through the proxy.
 */
function ExtensionsSection() {
  const registryVersion = useRegistryVersion();
  // null = first load in flight; failures degrade to [] (endpoint may not
  // exist yet) rather than an error box — a missing list must not nag.
  const [runtime, setRuntime] = useState<RuntimeExtensionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/webui/extensions");
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { data?: RuntimeExtensionInfo[] };
        if (!cancelled) setRuntime(json.data ?? []);
      } catch {
        if (!cancelled) setRuntime([]);
      }
    };
    void load();
    // Cadence owned by the scheduler (runs only while this section is
    // mounted); the scheduler's visibilitychange kick covers the "catch up
    // on tab return" duty the old local listener handled.
    return registerPoller({
      name: "extensions-runtime-list",
      minInterval: 10_000,
      run: () => load(),
    });
  }, []);

  // Extension-contributed settings sections; re-read when registrations change.
  const extSettings = useMemo(() => getContributions<SettingsContribution>("settings"), [registryVersion]);

  // Union: served folders/plugins PLUS any settings contributor that isn't in
  // the runtime manifest (a just-registered dev bundle before the next sync).
  const items = useMemo<RuntimeExtensionInfo[]>(() => {
    const list = runtime ?? [];
    const known = new Set(list.map((i) => i.id));
    const extras: RuntimeExtensionInfo[] = [];
    for (const s of extSettings) {
      if (known.has(s.id)) continue;
      known.add(s.id);
      extras.push({ id: s.id, name: s.item.title, description: s.item.description });
    }
    return [...list, ...extras];
  }, [runtime, extSettings]);

  const toggle = async (item: RuntimeExtensionInfo, enabled: boolean) => {
    setBusy(item.id);
    setActionError(null);
    try {
      const result = await api.webuiExtensionState(item.id, !enabled);
      const res = await fetch("/api/webui/extensions");
      if (res.ok) {
        const json = (await res.json()) as { data?: RuntimeExtensionInfo[] };
        setRuntime(json.data ?? []);
      }
      // Shipped browser bundles are owned by the in-repo Vite glob, which
      // cannot re-run after being unregistered — the server tells us when a
      // reload is required to re-register them.
      if (result.reload) setTimeout(() => window.location.reload(), 250);
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Extensions"
        note="one folder per extension — switch to pause, delete to uninstall"
      />
      {actionError && (
        <p className="rounded-md border border-[var(--surface-critical-base)] bg-[var(--surface-critical-weak)] px-2.5 py-1.5 text-xs text-[var(--surface-critical-strong)]">
          {actionError}
        </p>
      )}
      {runtime === null ? (
        <p className="py-3 text-center text-xs text-[var(--text-weaker)]">Loading…</p>
      ) : items.length === 0 ? (
        <Empty>No extensions installed.</Empty>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const sections = extSettings.filter((s) => s.id === item.id);
            // Only FOLDER extensions can be paused: the switch edits a
            // manifest.json. Engine plugin UI halves (source = their entry
            // file) and settings-only registrations are display-only here.
            const canToggle = !!item.source?.startsWith("webui-extensions:");
            return (
              <div
                key={item.id}
                className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-[13px] font-medium text-[var(--text-strong)]">
                        {item.name ?? item.id}
                      </span>
                      {item.name && (
                        <span className="truncate font-mono text-[10px] text-[var(--text-weaker)]">
                          {item.id}
                        </span>
                      )}
                      {item.origin && (
                        <span className="rounded-sm border border-[var(--border-weak-base)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-weaker)]">
                          {item.origin}
                        </span>
                      )}
                      {item.disabled && (
                        <span className="rounded-sm bg-[var(--surface-warning-weak)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--surface-warning-strong)]">
                          paused
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">{item.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {busy === item.id && <Spinner className="size-3.5" />}
                    <Switch
                      checked={!item.disabled}
                      disabled={busy !== null || !canToggle}
                      title={canToggle ? (item.disabled ? "Enable" : "Pause") : "Not a folder extension"}
                      onCheckedChange={(checked) => void toggle(item, checked)}
                    />
                  </div>
                </div>

                {(sections.length > 0 ||
                  (Array.isArray(item.settings) && item.settings.length > 0) ||
                  item.requires !== undefined) && (
                  // Each extension's own settings live INSIDE its card — the
                  // switch and its options read as one unit.
                  <div className="mt-2.5 space-y-2 border-t border-[var(--border-weak-base)] pt-2.5">
                    <DeclaredSettingsFields id={item.id} rawSchema={item.settings} />
                    <ExtensionContract info={item} />
                    {sections.map((section) => (
                      // Key includes the registry version: a hot-swapped
                      // registration remounts with a FRESH error boundary
                      // instead of staying stuck on the crashed fallback.
                      <SettingsSectionBoundary key={`${registryVersion}:${section.id}`} id={section.id}>
                        <div>
                          <h4 className="text-[12px] font-medium text-[var(--text-strong)]">
                            {section.item.title}
                          </h4>
                          {section.item.description && (
                            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">
                              {section.item.description}
                            </p>
                          )}
                          <div className="mt-2">{section.item.render()}</div>
                        </div>
                      </SettingsSectionBoundary>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Crash isolation per extension card's settings — one broken extension must
 * not blank the whole Extensions tab (mirrors registry TargetErrorBoundary).
 */
class SettingsSectionBoundary extends Component<
  { id: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error(`[extensions] settings section "${this.props.id}" crashed:`, err);
  }
  render() {
    if (this.state.failed) {
      return (
        <p className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-2 text-xs text-[var(--text-weaker)]">
          This extension's settings crashed.
        </p>
      );
    }
    return this.props.children;
  }
}
