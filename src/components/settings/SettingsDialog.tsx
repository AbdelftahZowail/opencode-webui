import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Blocks, Boxes, Cpu, FileJson2, Globe, Plug, Puzzle, Server, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { registerPoller } from "../../lib/scheduler";
import { getContributions, getRegisteredIds, subscribeRegistry, type SettingsContribution } from "../../extensions/registry";
import { ConfigSection } from "./ConfigSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { McpSection } from "./McpSection";
import { PluginsSection } from "./PluginsSection";
import { ProvidersSection } from "./ProvidersSection";
import { ServerSection } from "./ServerSection";
import { WebsearchSection } from "./WebsearchSection";
import { Empty, SectionHeader } from "./shared";

let openRequest: ((section?: string) => void) | null = null;

export function openSettings(section?: string) {
  openRequest?.(section);
}

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-3xl h-[min(84vh,660px)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const TABS = [
  { id: "providers", label: "Providers", icon: Cpu },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "mcp", label: "MCP", icon: Boxes },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "extensions", label: "Extensions", icon: Blocks },
  { id: "config", label: "Config", icon: FileJson2 },
  { id: "websearch", label: "Websearch", icon: Globe },
  { id: "server", label: "Server", icon: Server },
] as const;

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("providers");

  useEffect(() => {
    openRequest = (section) => {
      if (section) setTab(section);
      setOpen(true);
    };
    return () => {
      openRequest = null;
    };
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTab("providers");
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader className="pr-8">
            <DialogTitle>Settings</DialogTitle>
            <p className="text-xs text-[var(--text-weaker)]">
              Providers · integrations · MCP · plugins · extensions · config
            </p>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col">
            <TabsList className="mb-2 flex w-full flex-wrap justify-start gap-1 rounded-md bg-[var(--surface-base)] p-1">
              {TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  title={t.id === "integrations" ? "Connect providers" : undefined}
                  className="h-7 gap-1.5 rounded px-2 text-xs"
                >
                  <t.icon className="size-3.5" />
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <ScrollArea className="min-h-0 flex-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-3">
              <TabsContent value="providers">
                <ProvidersSection />
              </TabsContent>
              <TabsContent value="integrations">
                <IntegrationsSection />
              </TabsContent>
              <TabsContent value="mcp">
                <McpSection />
              </TabsContent>
              <TabsContent value="plugins">
                <PluginsSection />
              </TabsContent>
              <TabsContent value="extensions">
                <ExtensionsSection />
              </TabsContent>
              <TabsContent value="config">
                <ConfigSection />
              </TabsContent>
              <TabsContent value="websearch">
                <WebsearchSection />
              </TabsContent>
              <TabsContent value="server">
                <ServerSection />
              </TabsContent>
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

/**
 * Settings › Extensions: every folder extension the proxy serves, every id
 * registered in this page, and every settings section contributed by
 * extensions ("settings" collection). Mounted only while its tab is active
 * (Radix unmounts inactive tabs).
 *
 * Gating lives in the folders, not here: presence = installed, manifest
 * `disabled: true` = paused — so this tab states, it never toggles.
 */
function ExtensionsSection() {
  const registryVersion = useRegistryVersion();
  // null = first load in flight; failures degrade to [] (endpoint may not
  // exist yet) rather than an error box — a missing list must not nag.
  const [runtime, setRuntime] = useState<RuntimeExtensionInfo[] | null>(null);

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
  const registeredIds = useMemo(() => getRegisteredIds(), [registryVersion]);

  return (
    <div className="space-y-5">
      <div>
        <SectionHeader title="Extensions" note="one folder per extension — presence installs, manifest paused disables" />
        {runtime === null ? null : runtime.length === 0 ? (
          <Empty>No folder extensions installed.</Empty>
        ) : (
          <div className="space-y-1">
            {runtime.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-[var(--text-strong)]">{item.id}</p>
                  <p className="truncate text-[11px] text-[var(--text-weaker)]">{item.source ?? (item.url ?? "")}</p>
                </div>
                {item.disabled ? (
                  <span className="shrink-0 rounded-sm border border-[var(--border-weak-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-weaker)]">
                    paused
                  </span>
                ) : (
                  <span className="shrink-0 rounded-sm border border-transparent bg-[var(--surface-success-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-on-success-base)]">
                    on
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-1 text-[11px] text-[var(--text-weaker)]">
          pause with `"disabled": true` in the folder's manifest.json; delete the folder to uninstall.
        </p>
      </div>

      <div>
        <SectionHeader title="Registered in this page" />
        {registeredIds.length > 0 ? (
          <div className="mb-1 flex flex-wrap gap-1">
            {registeredIds.map((id) => (
              <span
                key={id}
                className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2 py-1 font-mono text-xs text-[var(--text-strong)]"
              >
                {id}
              </span>
            ))}
          </div>
        ) : (
          <Empty>No registrations.</Empty>
        )}
      </div>

      {extSettings.length > 0 && (
        <div>
          <SectionHeader title="Extension settings" note="contributed by installed extensions" />
          <div className="space-y-2">
            {extSettings.map((section) => (
              // Key includes the registry version: a hot-swapped registration
              // remounts with a FRESH error boundary instead of staying stuck
              // on the crashed fallback from the previous closure.
              <SettingsSectionBoundary
                key={`${registryVersion}:${section.id}`}
                id={section.id}
              >
                <section className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5">
                  <h4 className="text-xs font-medium text-[var(--text-strong)]">{section.item.title}</h4>
                  {section.item.description && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">{section.item.description}</p>
                  )}
                  <div className="mt-2">{section.item.render()}</div>
                </section>
              </SettingsSectionBoundary>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Crash isolation per contributed settings block — one broken extension must
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
        <p className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2 text-xs text-[var(--text-weaker)]">
          This extension's settings crashed.
        </p>
      );
    }
    return this.props.children;
  }
}
