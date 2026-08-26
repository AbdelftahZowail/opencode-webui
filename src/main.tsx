import * as React from "react";
import * as ReactJSXRuntime from "react/jsx-runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import { startStore, useStore } from "./store";
import "../ui-extensions";
import { log } from "./lib/log";
import { register } from "./extensions/registry";
import { api } from "./api/client";
import { startRuntimeExtensions } from "./lib/runtimeExtensions";

const DEBUG_CONSOLE = typeof localStorage !== "undefined" && localStorage.getItem("webui.debug") === "1";
(window as unknown as { __WEBUI_DEBUG_CONSOLE__?: boolean }).__WEBUI_DEBUG_CONSOLE__ = DEBUG_CONSOLE;

// Runtime extension bridge: plugin-shipped UI bundles (loaded lazily by
// lib/runtimeExtensions) reach the app ONLY through this object — it is the
// versioned public API surface for runtime extensions. Bundles carry their
// OWN React copies (bundled server-side), so these refs are for THEIR use.
(window as unknown as Record<string, unknown>).__opencodeUI = {
  version: 1,
  register,
  react: React,
  jsxRuntime: ReactJSXRuntime,
  useStore,
  api,
};

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
