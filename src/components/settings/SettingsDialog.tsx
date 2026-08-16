import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Boxes, Cpu, FileJson2, Globe, Plug, Puzzle, Server, XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ConfigSection } from "./ConfigSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { McpSection } from "./McpSection";
import { PluginsSection } from "./PluginsSection";
import { ProvidersSection } from "./ProvidersSection";
import { ServerSection } from "./ServerSection";
import { WebsearchSection } from "./WebsearchSection";

let openRequest: (() => void) | null = null;

export function openSettings() {
  openRequest?.();
}

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-3xl h-[min(84vh,660px)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const TABS = [
  { id: "providers", label: "Providers", icon: Cpu },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "mcp", label: "MCP", icon: Boxes },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "config", label: "Config", icon: FileJson2 },
  { id: "websearch", label: "Websearch", icon: Globe },
  { id: "server", label: "Server", icon: Server },
] as const;

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<string>("providers");

  useEffect(() => {
    openRequest = () => setOpen(true);
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
              Providers · integrations · MCP · plugins · config
            </p>
          </DialogHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col">
            <TabsList className="mb-2 flex w-full flex-wrap justify-start gap-1 rounded-md bg-[var(--surface-base)] p-1">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-7 gap-1.5 rounded px-2 text-xs">
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
