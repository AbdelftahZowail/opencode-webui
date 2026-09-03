/**
 * rich-render — DOM stratum: Claude-style inline visuals for chat messages.
 *
 * Three mechanisms, deliberately distinct — preserved with their separation:
 *
 * 1. BACKTICK code blocks (```lang) stay code-only. NEVER live-rendered.
 *    The webui styles these in MessageItem's markdown pipeline; this file
 *    adds no code-block styling of its own.
 *
 * 2. TILDE live fences (~~~html ~~~live-html ~~~live-js ~~~svg ~~~live-svg
 *    ~~~pdf ~~~live-pdf ~~~image ~~~live-image) render LIVE. HTML/SVG/JS
 *    mount in a sandboxed iframe (sandbox="allow-scripts", opaque origin —
 *    no allow-same-origin — plus a strict CSP meta allowlisting inline
 *    scripts/styles, the two common CDNs, and nothing else). PDF/image
 *    fences take a single URL (http(s) or data:) and render the viewer or
 *    image. Local file paths degrade to a clear note, never a broken frame.
 *    Toolbar per live block: live/code toggle, copy source, reload, open in
 *    new tab. Content mounts only when settled — never mid-stream.
 *
 * 3. IMAGES & PDFs inline: message images get a sane inline class; `.pdf`
 *    links get an inline Preview toggle card.
 *
 * Webui adaptation notes:
 * - Anchors: a fence is `pre > code.language-<tag>` (ReactMarkdown, no
 *   syntax highlighter) and the message boundary is the stable
 *   `[data-oc-message]` anchor.
 * - Streaming: the live/streaming projection (Conversation's
 *   LiveAssistantView) renders OUTSIDE any `[data-oc-message]` anchor, so
 *   scoping detection to `[data-oc-message]` descendants excludes streaming
 *   content structurally. On top of that, a block mounts only after its
 *   source reads identical on two consecutive quiet-period scans — even if a
 *   fence ever streams inside a message row, it can never mount mid-stream.
 * - Sibling injection uses the host kit (`foreign` inserts AFTER the anchor;
 *   order-preserving for lists), so live frames sit where the hidden code
 *   block was. The original `pre` is hidden with a CSS class only — React
 *   keeps owning it, and the class is re-asserted on every scan in case a
 *   re-render dropped it.
 *
 * React-safety: we NEVER remove or re-parent React-owned nodes. Everything
 * added (live frame, preview card, preview button) is a SIBLING of a
 * React-owned anchor; the anchor is hidden with a class only. The kit's
 * foreign-sibling registry cleans up when React drops the anchor (stream
 * settle, session switch, regenerate), and our own bookkeeping (hidden
 * classes, image tags, entry map) is torn down in the mount cleanup, so
 * uninstall restores stock rendering exactly.
 */

import type { DomKit } from "../../src/lib/domKit";

type LiveKind = "html" | "svg" | "pdf" | "image";

/** Tilde-fence language tags that trigger LIVE inline rendering. */
const LIVE_KINDS: Record<string, LiveKind> = {
  html: "html",
  live: "html",
  "live-html": "html",
  "live-js": "html",
  svg: "svg",
  "live-svg": "svg",
  pdf: "pdf",
  "live-pdf": "pdf",
  image: "image",
  "live-image": "image",
  "live-img": "image",
};

const KIND_LABELS: Record<LiveKind, string> = {
  html: "HTML",
  svg: "SVG",
  pdf: "PDF",
  image: "IMAGE",
};

/**
 * Document-level CSP for generated live documents (Anthropic-style
 * allowlist: inline scripts/styles, the two common CDNs, nothing else).
 */
const LIVE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "img-src data: blob: https:",
  "font-src https://fonts.gstatic.com",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PREF_KEY = "rich-render.enabled";
const PREF_EVENT = "rich-render:prefs";

/** Quiet period before a pending block is (re-)examined. */
const SETTLE_MS = 350;

/** Our own injected subtrees — never scanned as candidates. */
const OWN_SELECTOR = ".rr-live, .rr-pdf-preview";

const RR_CSS = [
  /* message images: sane inline treatment (core caps size; we keep ratio + radius) */
  ".rr-img{max-width:100%;height:auto;border-radius:8px;display:inline-block}",
  /* live frames */
  ".rr-live{margin:6px 0;border:1px solid var(--border-weak-base,rgba(128,128,128,.28));border-radius:10px;overflow:hidden;background:var(--surface-inset-base,rgba(128,128,128,.07))}",
  ".rr-live-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px 5px 12px;background:var(--surface-raised-base,rgba(128,128,128,.10));border-bottom:1px solid var(--border-weak-base,rgba(128,128,128,.16))}",
  ".rr-live-badge{display:inline-flex;align-items:center;gap:6px;font:600 11px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;color:var(--text-weak,#c4c9d1);user-select:none}",
  ".rr-live-dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 6px #3fb950}",
  ".rr-live-actions{display:inline-flex;gap:4px;align-items:center}",
  ".rr-live-btn{cursor:pointer;border:none;background:transparent;color:var(--text-weak,#8a8f98);border-radius:6px;padding:1px 9px;font:400 12px/20px ui-monospace,Menlo,Consolas,monospace;transition:background .12s ease,color .12s ease}",
  ".rr-live-btn:hover{background:rgba(128,128,128,.16);color:var(--text-strong,#e8eaed)}",
  ".rr-live-btn:focus-visible{outline:1.5px solid var(--surface-interactive-base,#4b9fff);outline-offset:1px}",
  ".rr-live-frame{height:380px;min-height:120px;resize:vertical;overflow:hidden;background:#fff;position:relative}",
  ".rr-live-frame iframe{width:100%;height:100%;border:none;display:block;background:#fff}",
  ".rr-live-frame .rr-live-code{display:none;margin:0;padding:10px 14px;overflow:auto;font:400 12.5px/19px ui-monospace,Menlo,Consolas,monospace;color:var(--text-strong,#e8eaed);background:var(--surface-inset-base,#161b22);white-space:pre;height:100%;box-sizing:border-box}",
  ".rr-live.rr-view-code .rr-live-frame iframe,",
  ".rr-live.rr-view-code .rr-live-frame .rr-live-pdf-frame,",
  ".rr-live.rr-view-code .rr-live-frame .rr-live-image{display:none}",
  ".rr-live.rr-view-code .rr-live-frame .rr-live-code{display:block}",
  ".rr-live-frame .rr-live-image{display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;background:#fff;padding:12px;box-sizing:border-box}",
  ".rr-live-frame .rr-live-image img{max-width:100%;max-height:100%;border-radius:6px;object-fit:contain}",
  ".rr-live-frame .rr-live-pdf-frame{width:100%;height:100%;border:none;display:block;background:#fff}",
  ".rr-live-frame .rr-live-note{margin:0;padding:16px;font:400 13px/20px system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text-weak,#c4c9d1);background:var(--surface-inset-base,rgba(128,128,128,.07))}",
  ".rr-live-frame .rr-live-note code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}",
  /* hide the original code block once a live frame replaced it */
  "pre.rr-hidden{display:none !important}",
  /* pdf preview cards */
  ".rr-pdf-preview{margin:4px 0 6px;border:1px solid var(--border-weak-base,rgba(128,128,128,.28));border-radius:10px;overflow:hidden;background:var(--surface-inset-base,rgba(128,128,128,.07))}",
  ".rr-pdf-preview-bar{display:flex;align-items:center;gap:8px;padding:4px 8px 4px 12px;background:var(--surface-raised-base,rgba(128,128,128,.10));border-bottom:1px solid var(--border-weak-base,rgba(128,128,128,.16))}",
  ".rr-pdf-preview-bar .rr-live-badge{color:#d29922}",
  ".rr-pdf-preview-bar .rr-live-dot{background:#d29922;box-shadow:0 0 6px #d29922}",
  ".rr-pdf-preview-bar .rr-pdf-name{min-width:0;flex:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 12px/20px ui-monospace,Menlo,Consolas,monospace;color:var(--text-weak,#8a8f98)}",
  ".rr-pdf-preview-frame{height:420px;min-height:160px;resize:vertical;overflow:hidden;background:#fff;position:relative}",
  ".rr-pdf-preview-frame iframe{width:100%;height:100%;border:none;display:block;background:#fff}",
].join("\n");

/* ---- small DOM helpers -------------------------------------------------- */

function makeEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function makeButton(className: string, text: string, title: string): HTMLButtonElement {
  const b = makeEl("button", className, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

function copyText(text: string): Promise<boolean> {
  const legacy = (): boolean => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => legacy(),
      );
    }
  } catch {
    /* fall through to legacy */
  }
  return Promise.resolve(legacy());
}

/* ---- live-fence detection -------------------------------------------------
 * The webui Markdown pipeline renders every fenced block (``` or ~~~) as
 *   pre > code.language-<tag>
 * with raw source as the code's text (no syntax highlighter). Backtick
 * fences with non-live tags simply never match LIVE_KINDS below, so they
 * stay code — the backtick/tilde distinction is enforced by the tag table,
 * and only settled message rows are scanned at all. */

interface LiveInfo {
  lang: string;
  kind: LiveKind;
  source: string;
}

function fenceLangOf(pre: HTMLPreElement): string {
  try {
    const code = pre.querySelector("code");
    if (!code) return "";
    const cls = code.getAttribute("class") ?? "";
    const m = /(?:^|\s)language-([^\s]+)/.exec(cls);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function inSettledMessage(node: Element): boolean {
  try {
    return node.closest("[data-oc-message]") !== null;
  } catch {
    return false;
  }
}

function isOwnNode(node: Element): boolean {
  try {
    return node.closest(OWN_SELECTOR) !== null;
  } catch {
    return false;
  }
}

function liveInfoOf(pre: HTMLPreElement): LiveInfo | null {
  const lang = fenceLangOf(pre);
  const kind = LIVE_KINDS[lang.toLowerCase()];
  if (kind === undefined) return null;
  let source = "";
  try {
    const code = pre.querySelector("code");
    if (code?.textContent != null) source = code.textContent;
  } catch {
    /* no-op */
  }
  return { lang, kind, source };
}

/* ---- payload helpers ---------------------------------------------------- */

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isDataUrl(s: string, mimePrefix?: string): boolean {
  return (
    typeof s === "string" &&
    s.slice(0, 5).toLowerCase() === "data:" &&
    (mimePrefix === undefined || s.toLowerCase().indexOf(mimePrefix) === 5)
  );
}

function looksLocalPath(s: string): boolean {
  return (
    typeof s === "string" &&
    (s.startsWith("/") || s.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(s)) &&
    !isHttpUrl(s) &&
    !isDataUrl(s)
  );
}

function singleUrl(source: string): string {
  // NOTE (webui adaptation): ReactMarkdown keeps the fence's trailing newline
  // in code.textContent, so the match must tolerate surrounding whitespace —
  // anchoring on [ \t] only would reject every source.
  const m = /^\s*(\S+)\s*$/.exec(source);
  return m !== null ? (m[1] ?? "") : "";
}

function buildDoc(source: string, kind: LiveKind): string {
  const trimmed = source.replace(/^\s+|\s+$/g, "");
  if (/<(!doctype|html\b|head\b|body\b)/i.test(trimmed)) return trimmed;
  const csp = '<meta http-equiv="Content-Security-Policy" content="' + LIVE_CSP + '">';
  const base =
    "<style>html,body{margin:0;padding:0}body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2328;background:#fff}</style>";
  if (kind === "svg") {
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      csp +
      base +
      '</head><body style="margin:0">' +
      source +
      "</body></html>"
    );
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    csp +
    base +
    "</head><body>" +
    source +
    "</body></html>"
  );
}

function openInNewTab(doc: string, mime?: string): void {
  try {
    const blob = new Blob([doc], { type: mime ?? "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (w !== null) w.opener = null;
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    /* no-op */
  }
}

/* ---- the live frame ----------------------------------------------------- */

interface LiveParts {
  wrap: HTMLDivElement;
  frame: HTMLDivElement;
  btnToggle: HTMLButtonElement;
  btnCopy: HTMLButtonElement;
  btnReload: HTMLButtonElement;
  btnOpen: HTMLButtonElement;
  lastSource: string;
}

interface LiveEntry {
  anchor: HTMLPreElement;
  parts: LiveParts;
  view: "live" | "code";
  /** kit cleanup for the foreign sibling (removes the wrap). */
  release: () => void;
}

function buildWrapper(info: LiveInfo): LiveParts {
  const wrap = makeEl("div", "rr-live");
  wrap.dataset.rrKind = info.kind;
  wrap.dataset.rrLang = info.lang;

  const bar = makeEl("div", "rr-live-bar");
  const badge = makeEl("span", "rr-live-badge");
  badge.appendChild(makeEl("span", "rr-live-dot"));
  badge.appendChild(document.createTextNode(" " + KIND_LABELS[info.kind] + " · LIVE"));

  const actions = makeEl("div", "rr-live-actions");
  const btnToggle = makeButton("rr-live-btn", "Show code", "Toggle between the rendered view and the source");
  const btnCopy = makeButton("rr-live-btn", "Copy", "Copy the source");
  const btnReload = makeButton("rr-live-btn", "Reload", "Re-run the content");
  const btnOpen = makeButton("rr-live-btn", "Open in new tab", "Open the rendered output in a new tab");
  actions.append(btnToggle, btnCopy, btnReload, btnOpen);
  bar.append(badge, actions);

  const frame = makeEl("div", "rr-live-frame");
  wrap.append(bar, frame);

  return { wrap, frame, btnToggle, btnCopy, btnReload, btnOpen, lastSource: info.source };
}

function renderPayload(parts: LiveParts, info: LiveInfo): void {
  parts.frame.textContent = "";
  const source = info.source;
  const url = singleUrl(source);

  if (info.kind === "pdf") {
    if (isHttpUrl(url) || isDataUrl(url, "application/pdf")) {
      const f = document.createElement("iframe");
      f.className = "rr-live-pdf-frame";
      f.setAttribute("src", url);
      f.setAttribute("referrerpolicy", "no-referrer");
      f.title = "Inline PDF viewer";
      parts.frame.appendChild(f);
    } else if (looksLocalPath(url)) {
      parts.frame.appendChild(
        makeEl(
          "p",
          "rr-live-note",
          "Local file paths cannot be loaded by the browser directly. Use a data:application/pdf;base64,… URL or an http(s) URL inside the " +
            info.lang +
            " fence (or open the file in a viewer).",
        ),
      );
    } else {
      parts.frame.appendChild(
        makeEl(
          "p",
          "rr-live-note",
          "Invalid PDF source. Put a single data:application/pdf;base64,… or http(s) URL on the first line of the " +
            info.lang +
            " fence.",
        ),
      );
    }
    parts.frame.appendChild(makeEl("pre", "rr-live-code", source));
    parts.lastSource = source;
    return;
  }

  if (info.kind === "image") {
    const holder = makeEl("div", "rr-live-image");
    if (isHttpUrl(url) || isDataUrl(url, "image/")) {
      const img = document.createElement("img");
      img.setAttribute("src", url);
      img.setAttribute("alt", "Inline image");
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
      holder.appendChild(img);
    } else if (looksLocalPath(url)) {
      holder.appendChild(
        makeEl(
          "p",
          "rr-live-note",
          "Local file paths cannot be loaded by the browser directly. Use a data:image/… or http(s) URL inside the " +
            info.lang +
            " fence.",
        ),
      );
    } else {
      holder.appendChild(
        makeEl(
          "p",
          "rr-live-note",
          "Invalid image source. Put a single data:image/… or http(s) URL on the first line of the " +
            info.lang +
            " fence.",
        ),
      );
    }
    parts.frame.appendChild(holder);
    parts.frame.appendChild(makeEl("pre", "rr-live-code", source));
    parts.lastSource = source;
    return;
  }

  /* html / svg: sandboxed iframe via srcdoc (opaque origin — no allow-same-origin) */
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("allow", "");
  iframe.title = "Live rendered content";
  iframe.setAttribute("srcdoc", buildDoc(source, info.kind));
  parts.frame.appendChild(iframe);

  const codeView = makeEl("pre", "rr-live-code");
  codeView.textContent = source;
  parts.frame.appendChild(codeView);
  parts.lastSource = source;
}

function wireToolbar(entry: LiveEntry): void {
  const { parts } = entry;
  parts.btnToggle.addEventListener("click", () => {
    entry.view = entry.view === "live" ? "code" : "live";
    parts.wrap.classList.toggle("rr-view-code", entry.view === "code");
    parts.btnToggle.textContent = entry.view === "live" ? "Show code" : "Show live";
  });
  parts.btnCopy.addEventListener("click", () => {
    const info = liveInfoOf(entry.anchor);
    void copyText(info !== null ? info.source : "").then((ok) => {
      if (!ok) return;
      const prev = parts.btnCopy.textContent;
      parts.btnCopy.textContent = "Copied";
      window.setTimeout(() => {
        parts.btnCopy.textContent = prev;
      }, 900);
    });
  });
  parts.btnReload.addEventListener("click", () => {
    const info = liveInfoOf(entry.anchor);
    if (info === null) return;
    renderPayload(parts, info);
  });
  parts.btnOpen.addEventListener("click", () => {
    const info = liveInfoOf(entry.anchor);
    if (info === null) return;
    if (info.kind === "pdf" || info.kind === "image") {
      const url = singleUrl(info.source);
      if (isHttpUrl(url)) {
        window.open(url, "_blank", "noopener");
      } else if (isDataUrl(url)) {
        openInNewTab(url, info.kind === "pdf" ? "application/pdf" : "image/*");
      }
      return;
    }
    openInNewTab(buildDoc(info.source, info.kind), "text/html");
  });
}

/* ---- image / pdf-link enhancement --------------------------------------- */

function buildPdfCard(src: string, label: string): HTMLDivElement {
  const card = makeEl("div", "rr-pdf-preview");
  const bar = makeEl("div", "rr-pdf-preview-bar");
  const badge = makeEl("span", "rr-live-badge");
  badge.appendChild(makeEl("span", "rr-live-dot"));
  badge.appendChild(document.createTextNode(" " + label));
  const name = makeEl("span", "rr-pdf-name", src.split("/").pop() || src);
  const openBtn = makeButton("rr-live-btn", "Open", "Open the PDF in a new tab");
  bar.append(badge, name, openBtn);
  const frame = makeEl("div", "rr-pdf-preview-frame");
  const f = document.createElement("iframe");
  f.setAttribute("src", src);
  f.setAttribute("referrerpolicy", "no-referrer");
  f.title = "Inline PDF viewer";
  frame.appendChild(f);
  openBtn.addEventListener("click", () => {
    if (/^(data:|blob:)/.test(src)) openInNewTab(src, "application/pdf");
    else window.open(src, "_blank", "noopener");
  });
  card.append(bar, frame);
  return card;
}

const PDF_HREF = /\.pdf($|\?)/i;

export default {
  mount(kit: DomKit) {
    kit.styles(RR_CSS);

    /** Mounted live frames: anchor pre → entry. */
    const mounted = new Map<HTMLPreElement, LiveEntry>();
    /** Release fns for pdf-link foreign nodes: anchor link → release. */
    const pdfLinks = new Map<HTMLAnchorElement, () => void>();
    /** Release fns for pdf-image cards: anchor img → release. */
    const imgReleases = new Map<HTMLImageElement, () => void>();
    /** Images we tagged (untagged on cleanup so uninstall is exact). */
    const taggedImages = new Set<HTMLImageElement>();
    /** Candidate pres awaiting their second identical observation. */
    const pending = new Map<HTMLPreElement, string>();

    let scanTimer: ReturnType<typeof setTimeout> | null = null;

    const prefEnabled = (): boolean => {
      try {
        return window.localStorage.getItem(PREF_KEY) !== "0";
      } catch {
        return true;
      }
    };

    /* -- transform: sibling frame + CSS-hide the original ------------------ */
    const ensureLive = (pre: HTMLPreElement): void => {
      const info = liveInfoOf(pre);
      if (info === null) return;
      const entry = mounted.get(pre);
      if (entry === undefined) {
        const parts = buildWrapper(info);
        let release: () => void = () => undefined;
        try {
          release = kit.foreign(pre, [parts.wrap]);
          pre.classList.add("rr-hidden");
        } catch {
          try {
            release();
          } catch {
            /* no-op */
          }
          return;
        }
        const next: LiveEntry = { anchor: pre, parts, view: "live", release };
        mounted.set(pre, next);
        renderPayload(parts, info);
        wireToolbar(next);
      } else {
        // Re-assert the hide (a React re-render may have dropped the class)
        // and re-render only when the settled source actually changed.
        try {
          if (!pre.classList.contains("rr-hidden")) pre.classList.add("rr-hidden");
        } catch {
          /* no-op */
        }
        if (entry.parts.lastSource !== info.source) renderPayload(entry.parts, info);
      }
    };

    const dropEntry = (pre: HTMLPreElement): void => {
      const entry = mounted.get(pre);
      if (entry === undefined) return;
      mounted.delete(pre);
      try {
        entry.release();
      } catch {
        /* no-op */
      }
      try {
        pre.classList.remove("rr-hidden");
      } catch {
        /* no-op */
      }
    };

    const teardownAll = (): void => {
      for (const pre of [...mounted.keys()]) dropEntry(pre);
      for (const [link, release] of [...pdfLinks]) {
        pdfLinks.delete(link);
        try {
          release();
        } catch {
          /* no-op */
        }
      }
      for (const [img, release] of [...imgReleases]) {
        imgReleases.delete(img);
        try {
          release();
        } catch {
          /* no-op */
        }
        try {
          img.classList.remove("rr-hidden");
        } catch {
          /* no-op */
        }
      }
      pending.clear();
      for (const img of [...taggedImages]) {
        taggedImages.delete(img);
        try {
          img.classList.remove("rr-img");
        } catch {
          /* no-op */
        }
      }
    };

    /* -- candidates -------------------------------------------------------- */
    const collectCandidates = (root: ParentNode): void => {
      let pres: HTMLPreElement[];
      try {
        pres = [...root.querySelectorAll("pre")] as HTMLPreElement[];
        // The root itself may be an appended fence (React appending a part to
        // an existing row): querySelectorAll only covers descendants.
        const self = root as Element;
        if (self.tagName === "PRE" && !(pres as Element[]).includes(self)) {
          pres.unshift(self as HTMLPreElement);
        }
      } catch {
        return;
      }
      for (const pre of pres) {
        if (isOwnNode(pre)) continue;
        if (!inSettledMessage(pre)) continue;
        if (mounted.has(pre)) continue;
        const info = liveInfoOf(pre);
        if (info === null) continue;
        if (!pending.has(pre)) pending.set(pre, info.source);
      }
    };

    const tagMessageImages = (): void => {
      let rows: NodeListOf<Element>;
      try {
        rows = document.querySelectorAll("[data-oc-message]");
      } catch {
        return;
      }
      for (const row of rows) {
        let imgs: NodeListOf<HTMLImageElement>;
        try {
          imgs = row.querySelectorAll("img");
        } catch {
          continue;
        }
        for (const img of imgs) {
          try {
            if (isOwnNode(img)) continue;
            if (img.classList.contains("rr-img")) continue;
            if (imgReleases.has(img)) continue;
            const src = img.getAttribute("src") ?? "";
            if (PDF_HREF.test(src)) {
              // A .pdf posing as an image: swap in the viewer card (sibling).
              if (!img.parentNode) continue;
              const card = buildPdfCard(src, "PDF · image");
              img.classList.add("rr-hidden");
              try {
                const release = kit.foreign(img, [card]);
                const anchor = img;
                imgReleases.set(anchor, () => {
                  try {
                    release();
                  } catch {
                    /* no-op */
                  }
                  try {
                    anchor.classList.remove("rr-hidden");
                  } catch {
                    /* no-op */
                  }
                });
              } catch {
                img.classList.remove("rr-hidden");
              }
            } else {
              img.classList.add("rr-img");
              taggedImages.add(img);
            }
          } catch {
            /* per-image isolation: one bad node never breaks the row */
          }
        }
      }
    };

    const enhancePdfLinks = (): void => {
      let rows: NodeListOf<Element>;
      try {
        rows = document.querySelectorAll("[data-oc-message]");
      } catch {
        return;
      }
      for (const row of rows) {
        let links: NodeListOf<HTMLAnchorElement>;
        try {
          links = row.querySelectorAll("a[href]");
        } catch {
          continue;
        }
        for (const a of links) {
          try {
            if (isOwnNode(a)) continue;
            if (pdfLinks.has(a)) continue;
            const href = a.getAttribute("href") ?? "";
            if (!PDF_HREF.test(href)) continue;
            const btn = makeButton("rr-live-btn", "Preview PDF", "Show an inline preview of this PDF");
            btn.style.marginLeft = "6px";
            const holder = makeEl("div", "rr-pdf-preview");
            holder.style.display = "none";
            const bar = makeEl("div", "rr-pdf-preview-bar");
            const badge = makeEl("span", "rr-live-badge");
            badge.appendChild(makeEl("span", "rr-live-dot"));
            badge.appendChild(document.createTextNode(" PDF"));
            const name = makeEl("span", "rr-pdf-name", href.split("/").pop() || href);
            const closeBtn = makeButton("rr-live-btn", "Close", "Close the preview");
            bar.append(badge, name, closeBtn);
            const frame = makeEl("div", "rr-pdf-preview-frame");
            holder.append(bar, frame);
            btn.addEventListener("click", () => {
              if (frame.firstElementChild === null) {
                const f = document.createElement("iframe");
                f.setAttribute("src", href);
                f.setAttribute("referrerpolicy", "no-referrer");
                f.title = "Inline PDF preview";
                frame.appendChild(f);
              }
              holder.style.display = "";
              try {
                holder.scrollIntoView({ block: "nearest" });
              } catch {
                /* no-op */
              }
            });
            closeBtn.addEventListener("click", () => {
              holder.style.display = "none";
            });
            const release = kit.foreign(a, [btn, holder]);
            pdfLinks.set(a, release);
          } catch {
            /* per-link isolation */
          }
        }
      }
    };

    /* -- settled scan -------------------------------------------------------
     * A pending block mounts only when its source reads IDENTICAL on two
     * consecutive scans with no mutation in between (SETTLE_MS of quiet).
     * Mounted blocks re-render when their settled source changes; anchors
     * React removed are pruned (the kit already removed their siblings). */
    const scan = (): void => {
      scanTimer = null;
      if (!prefEnabled()) return;
      // Prune anchors React dropped (session switch, regenerate).
      for (const pre of [...mounted.keys()]) {
        try {
          if (!pre.isConnected) dropEntry(pre);
        } catch {
          dropEntry(pre);
        }
      }
      for (const pre of [...pending.keys()]) {
        try {
          if (!pre.isConnected) pending.delete(pre);
        } catch {
          pending.delete(pre);
        }
      }
      for (const [link, release] of [...pdfLinks]) {
        try {
          if (!link.isConnected) {
            pdfLinks.delete(link);
            try {
              release();
            } catch {
              /* no-op */
            }
          }
        } catch {
          pdfLinks.delete(link);
        }
      }
      let changed = false;
      for (const [pre, lastSeen] of [...pending]) {
        let cur: string | null = null;
        try {
          if (!pre.isConnected || !inSettledMessage(pre) || isOwnNode(pre)) {
            pending.delete(pre);
            continue;
          }
          cur = liveInfoOf(pre)?.source ?? null;
        } catch {
          pending.delete(pre);
          continue;
        }
        if (cur === null) {
          pending.delete(pre);
          continue;
        }
        if (cur !== lastSeen) {
          pending.set(pre, cur);
          changed = true;
          continue;
        }
        // Second identical observation with quiet in between → settled.
        pending.delete(pre);
        try {
          ensureLive(pre);
        } catch {
          /* per-block isolation */
        }
      }
      try {
        tagMessageImages();
      } catch {
        /* no-op */
      }
      try {
        enhancePdfLinks();
      } catch {
        /* no-op */
      }
      if (changed) armScan();
    };

    const armScan = (): void => {
      if (scanTimer !== null) return;
      scanTimer = setTimeout(scan, SETTLE_MS);
    };

    const scanExisting = (): void => {
      try {
        collectCandidates(document.body);
      } catch {
        /* no-op */
      }
      armScan();
      // Images/links need no settle gate (pure styling + buttons, no iframe
      // mounts until clicked): apply on the first pass too.
      try {
        tagMessageImages();
      } catch {
        /* no-op */
      }
      try {
        enhancePdfLinks();
      } catch {
        /* no-op */
      }
    };

    // Fences can arrive as bare <pre> appends into an EXISTING row (poll
    // reconciliation), not just as fresh rows — watch both. The observer
    // fires post-insertion, so a detached-then-attached pre matches with
    // its settled ancestors present.
    const stopWatch = kit.watch(["[data-oc-message]", "[data-oc-message] pre"], (matched) => {
      try {
        for (const el of matched) collectCandidates(el);
      } catch {
        /* no-op */
      }
      armScan();
    });

    const onPref = (): void => {
      if (!prefEnabled()) {
        if (scanTimer !== null) {
          clearTimeout(scanTimer);
          scanTimer = null;
        }
        teardownAll();
      } else {
        scanExisting();
      }
    };
    window.addEventListener(PREF_EVENT, onPref);

    scanExisting();

    return () => {
      window.removeEventListener(PREF_EVENT, onPref);
      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }
      try {
        stopWatch();
      } catch {
        /* no-op */
      }
      teardownAll();
    };
  },
};
