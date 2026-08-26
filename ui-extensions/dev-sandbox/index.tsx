import { register } from "../../src/extensions/registry";
import { useStore } from "../../src/store";
import type { MessageInfo } from "../../src/api/types";

/**
 * dev-sandbox — living documentation for every extension kind. Registering
 * against regions, the command palette, message decorations, and an /ext
 * page. Delete the folder (or disable the id in config.ts) when not needed.
 */

/** Harvested by ui-extensions/index.ts for hot add/remove pruning. */
export const id = "dev-sandbox";

function SessionLabel() {
  const sessionID = useStore((s) => s.currentSessionID);
  return (
    <span className="font-mono text-[10px] text-[var(--text-weaker)]" title="dev-sandbox region item">
      ⛺ {sessionID ? sessionID.slice(0, 8) : "no session"}
    </span>
  );
}

// 1) REGION — render into any <Slot region="..."> marker in the app.
register({
  kind: "region",
  id: "dev-sandbox.header",
  region: "header.session.actions",
  render: () => <SessionLabel />,
});

// 2) COMMAND — shows up in the command palette ("Extension commands").
register({
  kind: "command",
  id: "dev-sandbox.ping",
  title: "Sandbox: log current session id",
  run: (ctx) => console.log("[dev-sandbox] ping, session:", ctx.sessionID),
});

// 3) MESSAGE DECORATION — per-message extras; return null to skip a message.
register({
  kind: "message.decoration",
  id: "dev-sandbox.cost",
  render: ({ message }: { messageID: string; message: MessageInfo }) =>
    message.type === "assistant" && message.cost ? (
      <span className="font-mono text-[10px] text-[var(--text-weaker)]">
        ${message.cost.toFixed(4)}
      </span>
    ) : null,
});

// 4) PAGE — reachable at /ext/dev-sandbox once registered.
register({
  kind: "page",
  id: "dev-sandbox",
  title: "Extension sandbox",
  description: "Demo page rendered by the dev-sandbox extension.",
  render: () => (
    <div className="space-y-2 text-sm text-[var(--text-base)]">
      <p>If you can read this, the page kind works end-to-end.</p>
      <p className="text-[var(--text-weaker)]">
        Route: <code>/ext/dev-sandbox</code> — derived from the extension id.
      </p>
    </div>
  ),
});

// 5) SETTINGS — a titled section inside the app's Settings page
//    (Settings › Extensions › Extension settings).
register({
  kind: "settings",
  id: "dev-sandbox.settings",
  title: "Sandbox",
  description: "Example section contributed by an extension.",
  render: () => (
    <p className="text-sm text-[var(--text-weaker)]">
      Nothing to configure — this proves extensions can contribute settings UI.
      Persistence is the extension's own business (localStorage or engine
      storage via the API).
    </p>
  ),
});

// Self-accept so editing this extension hot-swaps it live.
if (import.meta.hot) import.meta.hot.accept();
