/**
 * Live inline previews for tilde fences (~~~html / ~~~svg / ~~~pdf / ~~~image
 * plus the live-* aliases).
 *
 * Design (Claude-widget-like): the CONTENT is the element — no badge bar, no
 * frame around it. HTML/SVG render on a transparent, content-sized canvas
 * (height reported by the sandboxed doc itself); images render bare; PDFs keep
 * a white sheet (the browser viewer needs one). A compact action pill floats in
 * on hover / focus-within: Copy as image / Download SVG / Download PNG for SVG,
 * Copy / Download / Open / Source elsewhere. Minimal chrome, full parity.
 *
 * Security model (unchanged, deliberate):
 *  - HTML/SVG/JS render in a sandboxed iframe (`sandbox="allow-scripts"` — no
 *    `allow-same-origin`, so the document is an opaque origin and cannot read
 *    cookies or reach the webui session) with a strict CSP on generated docs.
 *  - PDF/image fences take a single URL (http(s) or data:) rendered by the
 *    browser's own viewer.
 *  - "Open in a new tab" for HTML/SVG is contained the SAME way: because a
 *    `blob:` URL carries the creator's origin, the generated document is opened
 *    inside a nested opaque-origin sandboxed iframe (see `sandboxedDoc`), never
 *    as a top-level same-origin document.
 *  - There is NO raw-HTML path on the host origin; the source is only ever
 *    shown escaped, in a <pre>.
 *
 * Streaming: previews render while streaming (two-way iframe binding + text
 * blobs make it cheap); the HTML/SVG iframe key debounces the srcdoc churn
 * (~200ms) so a token burst does not reload the frame on every commit.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Code,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Image as ImageIcon,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { copyText } from "./clipboard";
import { setMarkdownRendering } from "./controls";
import type { LiveFenceInfo, LiveKind } from "./fence";

const KIND_LABELS: Record<LiveKind, string> = {
  html: "HTML",
  svg: "SVG",
  pdf: "PDF",
  image: "Image",
};

/**
 * Document-level CSP for generated live documents (Anthropic-style allowlist:
 * inline scripts/styles, the two common CDNs, nothing else).
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

/**
 * The host page's surface color. Iframe canvases paint OPAQUE (a transparent
 * document shows the UA canvas — white — not the app behind it), so the
 * generated doc's canvas must match the app's surface to blend seamlessly.
 */
function hostSurfaceColor(): string {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  } catch {
    /* no DOM (SSR/tests) */
  }
  return "#0b0d12";
}

/** Build a self-contained HTML document for a live HTML/SVG fence. */
function buildDoc(source: string): string {
  const trimmed = source.trim();
  if (/<(!doctype|html\b|head\b|body\b)/i.test(trimmed)) return trimmed;
  const csp = `<meta http-equiv="Content-Security-Policy" content="${LIVE_CSP}">`;
  const style = `<style>html,body{margin:0;padding:0;background:${hostSurfaceColor()}}html{color-scheme:dark}body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#e6edf3}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${style}</head><body>${source}</body></html>`;
}

/**
 * Auto-height contract: the sandboxed doc reports its own height to the host
 * (the host cannot measure an opaque-origin frame). Appended to EVERY generated
 * doc — including full documents — so the frame is content-sized, Claude-style.
 */
function withHeightScript(doc: string): string {
  const script =
    "<script>(function(){function send(){try{var b=document.body;var h=Math.max(b.scrollHeight,Math.ceil(b.getBoundingClientRect().height),b.offsetHeight);parent.postMessage({__ocPreviewHeight:h},'*')}catch(e){}}var t;function deb(){clearTimeout(t);t=setTimeout(send,40)}window.addEventListener('load',send);window.addEventListener('message',function(e){if(e&&e.data&&e.data.__ocPreviewPing)send()});if(window.ResizeObserver){new ResizeObserver(deb).observe(document.body)}else{setInterval(send,500)}[0,60,200,600,1500].forEach(function(ms){setTimeout(send,ms)})})()</script>";
  return /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, `${script}</body>`) : doc + script;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isDataUrl(s: string, mimePrefix?: string): boolean {
  return s.slice(0, 5).toLowerCase() === "data:" && (mimePrefix === undefined || s.slice(5).toLowerCase().startsWith(mimePrefix));
}

/** Raster-only `data:image/*` — SVG is script-capable and deliberately excluded. */
function isRasterDataUrl(s: string): boolean {
  return /^data:image\/(?!svg)/i.test(s.trim());
}

function looksLocalPath(s: string): boolean {
  return (
    (s.startsWith("/") || s.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(s)) &&
    !isHttpUrl(s) &&
    !isDataUrl(s)
  );
}

/** The fence body must be a single URL for pdf/image kinds. */
function singleUrl(source: string): string {
  const m = /^\s*(\S+)\s*$/.exec(source);
  return m ? m[1]! : "";
}

/** Open a URL or generated document in a new tab without leaking `opener`. */
function openExternal(url: string): void {
  try {
    const w = window.open(url, "_blank", "noopener");
    if (w) w.opener = null;
  } catch {
    /* popup blocked — nothing to do */
  }
}

/** Open a blob in a new tab; the object URL is revoked later. */
function openBlob(blob: Blob, revokeMs = 60_000): void {
  try {
    const url = URL.createObjectURL(blob);
    openExternal(url);
    window.setTimeout(() => URL.revokeObjectURL(url), revokeMs);
  } catch {
    /* no-op */
  }
}

/** Blob-URL open for a generated document. */
function openDoc(doc: string, mime: string, revokeMs = 60_000): void {
  openBlob(new Blob([doc], { type: mime }), revokeMs);
}

/** Save bytes under a filename (download). */
function downloadBlob(blob: Blob, name: string): void {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch {
    /* no-op */
  }
}

function downloadText(text: string, mime: string, name: string): void {
  downloadBlob(new Blob([text], { type: mime }), name);
}

/**
 * Rasterize a loaded image URL to a PNG blob. Returns null when the image
 * cannot load or the canvas is tainted (cross-origin without CORS) — callers
 * degrade to no-op rather than pretending success.
 */
async function urlToPngBlob(url: string, scale = 1): Promise<Blob | null> {
  try {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
      img.src = url;
    });
    const w = img.naturalWidth || 320;
    const h = img.naturalHeight || 180;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w * scale, h * scale);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}

/** Rasterize an SVG source string to a PNG blob (for copy/download). */
async function svgToPngBlob(svg: string, scale = 2): Promise<Blob | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    return await urlToPngBlob(url, scale);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Copy a PNG blob to the clipboard (image/png only — the one universal type). */
async function copyPngBlob(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contain untrusted document markup before it is opened TOP-LEVEL. A `blob:`
 * URL carries the creator's origin, so navigating to the raw document would run
 * agent-supplied script on the webui origin (cookies / localStorage / `/api`).
 * The payload therefore goes inside a nested opaque-origin frame — the same
 * `sandbox="allow-scripts"` containment the inline preview uses — and the outer
 * wrapper we open is static and script-free.
 */
function sandboxedDoc(doc: string): string {
  const attr = doc
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title><style>html,body{margin:0;height:100%}iframe{border:0;position:fixed;inset:0;width:100%;height:100%;background:transparent}</style></head><body><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attr}"></iframe></body></html>`;
}

/**
 * Open inert-media bytes decoded from a `data:` URL. `data:` URLs cannot be
 * navigated to at the top level in modern browsers, and wrapping the URL string
 * itself in a blob (rather than its bytes) would only show the literal text —
 * so decode first, then open the resulting blob. Callers gate this to inert
 * types only — `application/pdf` and RASTER `image/*` (an `image/svg+xml` or
 * `text/html` payload is script-capable and must never be opened top-level).
 */
async function openDataUrl(dataUrl: string): Promise<void> {
  try {
    openBlob(await (await fetch(dataUrl)).blob());
  } catch {
    /* no-op */
  }
}

/** Short label for a URL (filename, or "data:*"). */
function urlLabel(url: string): string {
  if (isDataUrl(url)) return "data: URL";
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname.split("/").pop() || url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Minimal chrome: a hover-revealed action pill
// ---------------------------------------------------------------------------

const PILL_LABELED =
  "inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]";
const PILL_ICON =
  "inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]";

/** The floating pill: invisible until the block is hovered or focused within. */
function HoverBar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      <div className="flex items-center gap-0.5 rounded-full border border-[var(--border-weak-base)] bg-[color:var(--surface-float-base)] p-0.5 shadow-lg">
        {children}
      </div>
    </div>
  );
}

/** Escaped source view shared by every kind (never raw HTML on this origin). */
function SourceView({ source }: { source: string }) {
  return (
    <pre className="m-0 max-h-96 overflow-auto whitespace-pre p-3 font-mono text-xs leading-relaxed text-[var(--text-base)]">
      {source}
    </pre>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-3 text-xs leading-relaxed text-[var(--text-weak)]">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--surface-warning-strong)]" />
      <div>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-kind bodies
// ---------------------------------------------------------------------------

/** Sandboxed HTML/SVG canvas: transparent, content-sized via postMessage. */
function IframeBody({ doc, reloadKey }: { doc: string; reloadKey: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { __ocPreviewHeight?: unknown } | null;
      if (!data || typeof data.__ocPreviewHeight !== "number") return;
      if (e.source !== ref.current?.contentWindow) return;
      setHeight(Math.max(32, Math.min(640, Math.ceil(data.__ocPreviewHeight))));
    };
    window.addEventListener("message", onMessage);
    // The doc's first sends can race the listener attach (and ResizeObserver
    // never fires again if the size settles) — ping it once the listener is up.
    const ping = () => ref.current?.contentWindow?.postMessage({ __ocPreviewPing: true }, "*");
    const t1 = window.setTimeout(ping, 60);
    const t2 = window.setTimeout(ping, 400);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [reloadKey]);

  return (
    <iframe
      ref={ref}
      key={reloadKey}
      title="Live rendered content"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={height ? { height: `${height}px` } : undefined}
      className="block min-h-16 w-full border-0 bg-transparent"
    />
  );
}

/** Bare image — no frame, no white sheet, just the picture. */
function ImageBody({ url, reloadKey }: { url: string; reloadKey: number }) {
  return (
    <div className="flex justify-center">
      {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
      <img
        key={reloadKey}
        src={url}
        alt="Inline preview"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="max-h-96 max-w-full rounded-md border border-[var(--border-weak-base)] object-contain"
      />
    </div>
  );
}

/** PDF viewer keeps a white sheet — the browser viewer paints its own paper. */
function PdfBody({ url, reloadKey }: { url: string; reloadKey: number }) {
  return (
    <div className="h-[300px] min-h-[120px] resize-y overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-white">
      <iframe
        key={reloadKey}
        title="Inline PDF viewer"
        src={url}
        referrerPolicy="no-referrer"
        className="block size-full border-0 bg-white"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

export function PreviewBlock({ info }: { info: LiveFenceInfo }) {
  const { kind, lang, source } = info;
  const [view, setView] = useState<"preview" | "source">("preview");
  const [flash, setFlash] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const url = useMemo(() => singleUrl(source), [source]);

  // Debounced doc so a streaming HTML/SVG fence does not reassign srcdoc on
  // every token commit (which reloads the iframe and visibly flickers).
  const doc = useDebouncedValue(
    kind === "html" || kind === "svg" ? withHeightScript(buildDoc(source)) : "",
    200,
  );

  const signal = (label: string) => {
    setFlash(label);
    window.setTimeout(() => setFlash(null), 1200);
  };

  const onCopySource = () => {
    void copyText(source).then((ok) => {
      if (ok) signal("Copied");
    });
  };

  const onCopyLink = () => {
    void copyText(url).then((ok) => {
      if (ok) signal("Copied");
    });
  };

  const onOpen = () => {
    if (kind === "html" || kind === "svg") {
      openDoc(sandboxedDoc(buildDoc(source)), "text/html");
    } else if (kind === "pdf" && isDataUrl(url, "application/pdf")) {
      void openDataUrl(url);
    } else if (kind === "image" && isRasterDataUrl(url)) {
      void openDataUrl(url);
    } else if ((isHttpUrl(url) || url.startsWith("/")) && !url.startsWith("//")) {
      // Relative paths are webui-served (shelf/API); never open protocol-relative.
      openExternal(url);
    }
  };

  const onDownloadDoc = (mime: string, name: string) => {
    downloadText(source, mime, name);
    signal("Saved");
  };

  const onDownloadPng = () => {
    void svgToPngBlob(source).then((blob) => {
      if (blob) {
        downloadBlob(blob, "preview.png");
        signal("Saved");
      }
    });
  };

  const onCopyImage = () => {
    const from = kind === "svg" ? svgToPngBlob(source) : urlToPngBlob(url);
    void from.then((blob) => {
      if (blob) void copyPngBlob(blob).then((ok) => ok && signal("Copied"));
    });
  };

  const onDownloadMedia = () => {
    if (!url) return;
    void (async () => {
      try {
        downloadBlob(await (await fetch(url)).blob(), urlLabel(url));
        signal("Saved");
      } catch {
        onOpen();
      }
    })();
  };

  const reload = () => setReloadKey((k) => k + 1);

  /** The pill's per-kind actions. */
  const actions = (): ReactNode[] => {
    const nodes: ReactNode[] = [];
    if (kind === "svg") {
      nodes.push(
        <button key="ci" type="button" className={PILL_LABELED} onClick={onCopyImage} title="Copy the rendered SVG as a PNG image">
          {flash === "Copied" ? <Check className="size-3" /> : <ImageIcon className="size-3" />}
          {flash === "Copied" ? "Copied" : "Copy as image"}
        </button>,
        <button key="dsvg" type="button" className={PILL_LABELED} onClick={() => onDownloadDoc("image/svg+xml", "preview.svg")} title="Download the SVG source">
          <Download className="size-3" />
          Download SVG
        </button>,
        <button key="dpng" type="button" className={PILL_LABELED} onClick={onDownloadPng} title="Download a PNG raster of the SVG">
          <Download className="size-3" />
          Download PNG
        </button>,
      );
    } else if (kind === "html") {
      nodes.push(
        <button key="cs" type="button" className={PILL_LABELED} onClick={onCopySource} title="Copy the fence source">
          {flash === "Copied" ? <Check className="size-3" /> : <Copy className="size-3" />}
          {flash === "Copied" ? "Copied" : "Copy"}
        </button>,
        <button key="dhtml" type="button" className={PILL_LABELED} onClick={() => onDownloadDoc("text/html", "preview.html")} title="Download the HTML">
          <Download className="size-3" />
          Download
        </button>,
      );
    } else if (kind === "image") {
      nodes.push(
        <button key="ci" type="button" className={PILL_LABELED} onClick={onCopyImage} title="Copy the image to the clipboard">
          {flash === "Copied" ? <Check className="size-3" /> : <ImageIcon className="size-3" />}
          {flash === "Copied" ? "Copied" : "Copy image"}
        </button>,
        <button key="dimg" type="button" className={PILL_LABELED} onClick={onDownloadMedia} title="Download the image">
          <Download className="size-3" />
          Download
        </button>,
      );
    } else {
      nodes.push(
        <button key="dpdf" type="button" className={PILL_LABELED} onClick={onDownloadMedia} title="Download the PDF">
          <Download className="size-3" />
          Download
        </button>,
        <button key="cl" type="button" className={PILL_LABELED} onClick={onCopyLink} title="Copy the PDF link">
          {flash === "Copied" ? <Check className="size-3" /> : <Copy className="size-3" />}
          {flash === "Copied" ? "Copied" : "Copy link"}
        </button>,
      );
    }
    nodes.push(
      <button
        key="toggle"
        type="button"
        className={PILL_ICON}
        onClick={() => setView((v) => (v === "preview" ? "source" : "preview"))}
        title={view === "preview" ? "Show the fence source" : "Show the preview"}
      >
        {view === "preview" ? <Code className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>,
      <button key="open" type="button" className={PILL_ICON} onClick={onOpen} title="Open in a new tab">
        <ExternalLink className="size-3.5" />
      </button>,
      <button key="reload" type="button" className={PILL_ICON} onClick={reload} title="Reload the preview">
        <RefreshCw className="size-3.5" />
      </button>,
      <button
        key="pause"
        type="button"
        className={PILL_ICON}
        onClick={() => setMarkdownRendering(false)}
        title="Pause all inline previews (show source instead)"
      >
        <EyeOff className="size-3.5" />
      </button>,
    );
    return nodes;
  };

  // pdf/image: a single URL line only.
  if (kind === "pdf" || kind === "image") {
    const valid =
      (kind === "pdf" && (isHttpUrl(url) || isDataUrl(url, "application/pdf"))) ||
      (kind === "image" && (isHttpUrl(url) || isDataUrl(url, "image/")));
    const isLocal = looksLocalPath(url);
    const body: ReactNode =
      view === "source" ? (
        <div className="overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]">
          <SourceView source={source} />
        </div>
      ) : valid ? (
        kind === "pdf" ? (
          <PdfBody url={url} reloadKey={reloadKey} />
        ) : (
          <ImageBody url={url} reloadKey={reloadKey} />
        )
      ) : (
        <Note>
          {isLocal
            ? "Local file paths cannot be loaded by the browser directly. Use a data: or http(s) URL inside the fence."
            : `Put a single ${kind === "pdf" ? "data:application/pdf;base64,… or http(s)" : "data:image/… or http(s)"} URL on the first line of the ~~~${lang} fence.`}
        </Note>
      );
    return (
      <div data-oc-preview={kind} className="group relative my-3">
        {body}
        <HoverBar>{actions()}</HoverBar>
      </div>
    );
  }

  // html / svg: sandboxed iframe (opaque origin) rendering the generated doc.
  return (
    <div data-oc-preview={kind} className="group relative my-3">
      {view === "source" ? (
        <div className="overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]">
          <SourceView source={source} />
        </div>
      ) : (
        <IframeBody doc={doc} reloadKey={reloadKey} />
      )}
      <HoverBar>{actions()}</HoverBar>
    </div>
  );
}

/**
 * Paused-state block: previews are turned off, so the fence shows escaped
 * source with a clear pause marker — consistent geometry, no secret mount
 * rule, and the tilde convention still visible.
 */
export function PreviewPausedBlock({ info }: { info: LiveFenceInfo }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void copyText(info.source).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div
      data-oc-preview={info.kind}
      data-oc-preview-paused
      className="group relative my-3 overflow-hidden rounded-lg border border-dashed border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]"
    >
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px] text-[var(--text-weaker)]">
        <EyeOff className="size-3" />
        {KIND_LABELS[info.kind]} · preview paused
      </div>
      <SourceView source={info.source} />
      <HoverBar>
        <button
          type="button"
          className={PILL_LABELED}
          onClick={() => setMarkdownRendering(true)}
          title="Resume inline previews"
        >
          <Eye className="size-3" />
          Resume
        </button>
        <button type="button" className={PILL_ICON} onClick={onCopy} title="Copy the fence source">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </HoverBar>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small hook
// ---------------------------------------------------------------------------

/** Debounce a value; first read is immediate so nothing pops in late. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      setDebounced(value);
      return;
    }
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
