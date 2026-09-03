import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
import { log } from "./lib/log";
import { installExtensionBridge } from "./lib/extensionApi";
import { startRuntimeExtensions } from "./lib/runtimeExtensions";

const DEBUG_CONSOLE = typeof localStorage !== "undefined" && localStorage.getItem("webui.debug") === "1";
(window as unknown as { __WEBUI_DEBUG_CONSOLE__?: boolean }).__WEBUI_DEBUG_CONSOLE__ = DEBUG_CONSOLE;

// Runtime extension bridge: the ONE extension API surface (spec §10 —
// register, react, api, store, prefs, notify, services, dom kit, kv),
// shared identically by external bundles (via window.__opencodeUI) and our
// shipped extensions (via getExtensionApi()). Installed before the loader
// starts so the object always exists when a bundle executes.
installExtensionBridge();

startRuntimeExtensions();

startStore();
log("boot", `app render (console mirror: ${DEBUG_CONSOLE ? "on" : "off"})`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
