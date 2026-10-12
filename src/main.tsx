import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";
import { startStore } from "./store";
import "../webui-extensions";
// Core targets must EXECUTE before any <Target> renders: autoRegister calls
// live inside the component modules, and nothing else imports them (App only
// references them by target id). Without these side-effect imports every
// Target resolves to null — blank sidebar, blank transcript. Keep this list
// next to the modules; the registry warns at boot for targets with no core.
import "./components/Sidebar";
import "./components/Conversation";
import "./components/Composer";
import "./components/MessageItem";
import "./components/ToolCard";
import "./components/DiffViewer";
import "./components/WorktreePanel";
import "./components/StashPanel";
import "./components/StatsPanel";
import "./components/TimelineDialog";
import "./components/SessionTabs";
import "./components/SessionPins";
import "./components/DebugDialog";
import "./components/PairDialog";
import "./components/ErrorDetailsDialog";
import "./components/ReconnectOverlay";
import "./components/UpdateNotice";
import "./components/SessionListDialog";
import "./components/OpenPicker";
import { log } from "./lib/log";
import { hasCoarsePointer } from "./lib/platform";
import { registerServiceWorker, startLiveTile } from "./lib/pwa";
import { ensureMcpStatus } from "./lib/mcpStatus";
import { installExtensionBridge } from "./lib/extensionApi";
import { startRuntimeExtensions } from "./lib/runtimeExtensions";
import { loadCustomThemes } from "./lib/themeFiles";
import { startAttention } from "./lib/attention";

const DEBUG_CONSOLE = typeof localStorage !== "undefined" && localStorage.getItem("webui.debug") === "1";
(window as unknown as { __WEBUI_DEBUG_CONSOLE__?: boolean }).__WEBUI_DEBUG_CONSOLE__ = DEBUG_CONSOLE;

// Runtime extension bridge: the ONE extension API surface (spec §10 —
// register, react, api, store, prefs, notify, services, dom kit, kv),
// shared identically by external bundles (via window.__opencodeUI) and our
// shipped extensions (via getExtensionApi()). Installed before the loader
// starts so the object always exists when a bundle executes.
installExtensionBridge();

startRuntimeExtensions();
// Custom themes (`<config>/themes/*.json`) discovered at boot so they appear
// in the picker/appearance settings without an explicit reload.
void loadCustomThemes();

startStore();
startAttention();
registerServiceWorker();
startLiveTile();
// MCP status is global (one poller, one cache) — warm it at boot so the
// header indicator paints instantly instead of fetching per session switch.
ensureMcpStatus();
log("boot", `app render (console mirror: ${DEBUG_CONSOLE ? "on" : "off"})`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {/* One provider for the whole tree: session rows render in the sidebar
          AND in the search overlay, so the provider cannot live in either. */}
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);

/**
 * Desktop keeps the shell instant: warm the code-split xterm chunk once the
 * page is idle, so opening a PTY resolves from cache instead of fetching on
 * click. Phones intentionally skip this — there the whole point is not paying
 * for xterm at all until a shell is actually opened.
 */
if (!hasCoarsePointer()) {
  const warm = () => {
    void import("./components/TerminalView");
    // Warm the shiki engine + Oniguruma wasm on desktop idle so the first code
    // block highlights without a plain→highlight swap (R1). Phones skip it.
    void import("./lib/markdown/shiki").then((m) => m.warmHighlighter());
  };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (idle) idle(warm);
  else setTimeout(warm, 2500);
}
