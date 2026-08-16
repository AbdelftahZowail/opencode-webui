import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import { startStore } from "./store";
import "../ui-extensions";
import { log } from "./lib/log";

const DEBUG_CONSOLE = typeof localStorage !== "undefined" && localStorage.getItem("webui.debug") === "1";
(window as unknown as { __WEBUI_DEBUG_CONSOLE__?: boolean }).__WEBUI_DEBUG_CONSOLE__ = DEBUG_CONSOLE;

startStore();
log("boot", `app render (console mirror: ${DEBUG_CONSOLE ? "on" : "off"})`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
