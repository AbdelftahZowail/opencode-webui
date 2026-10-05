import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, Loader2, X } from "lucide-react";
import {
  formatMtime,
  formatSize,
  kindLabel,
  shelfAbsoluteUrl,
  shelfFileUrl,
  type ShelfEntry,
} from "./shelfApi";

const TEXT_PREVIEW_LIMIT = 256 * 1024;

/**
 * Inline preview for one shelf entry: images, video, audio and PDFs render in
 * the browser's own inert viewers; text is fetched as text/plain (React escapes
 * it, so nothing from the shelf becomes markup on this origin). Anything else
 * is a download, not a preview.
 */
export function ShelfPreview({ entry, onClose }: { entry: ShelfEntry; onClose: () => void }) {
  const url = shelfFileUrl(entry.path);
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (entry.kind !== "text") return;
    let cancelled = false;
    setText(null);
    setTextError(null);
    setTruncated(false);
    fetch(url, { headers: { accept: "text/plain" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.text();
        if (cancelled) return;
        if (body.length > TEXT_PREVIEW_LIMIT) {
          setText(body.slice(0, TEXT_PREVIEW_LIMIT));
          setTruncated(true);
        } else {
          setText(body);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setTextError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.kind, entry.path, url]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shelfAbsoluteUrl(entry.path));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the open/download buttons still work */
    }
  }

  const meta = [kindLabel(entry.kind), formatSize(entry.size), formatMtime(entry.mtime)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${entry.name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="m-auto flex max-h-[92dvh] w-[min(1100px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-float-base)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-[var(--border-base)] px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-[var(--text-strong)]" title={entry.path}>
              {entry.name}
            </div>
            <div className="truncate font-mono text-[11px] text-[var(--text-weaker)]" title={meta}>
              {entry.path.includes("/") ? `${entry.path} · ${meta}` : meta}
            </div>
          </div>
          <button
            type="button"
            onClick={copyLink}
            title="Copy link"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            <Copy className="size-3" />
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open in a new tab"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            <ExternalLink className="size-3" />
            Open
          </a>
          <a
            href={shelfFileUrl(entry.path, { download: true })}
            title="Download"
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            <Download className="size-3" />
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close preview"
            className="inline-flex cursor-pointer items-center justify-center rounded-md p-1 text-[var(--text-weak)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--background-strong)] p-3">
          {entry.kind === "image" && (
            <img src={url} alt={entry.name} className="max-h-[80dvh] max-w-full object-contain" />
          )}
          {entry.kind === "video" && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={url} controls className="max-h-[80dvh] max-w-full" />
          )}
          {entry.kind === "audio" && <audio src={url} controls className="w-full max-w-xl" />}
          {entry.kind === "pdf" && (
            <iframe src={url} title={entry.name} className="h-[80dvh] w-full rounded-md bg-white" />
          )}
          {entry.kind === "text" && (
            <div className="w-full">
              {textError ? (
                <p className="text-sm text-[var(--text-on-critical-base)]">Could not read: {textError}</p>
              ) : text === null ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-weaker)]">
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  {truncated && (
                    <p className="mb-2 text-xs text-[var(--text-weaker)]">
                      Showing the first {formatSize(TEXT_PREVIEW_LIMIT)} —{" "}
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[var(--text-interactive-base)] underline underline-offset-2"
                      >
                        open the full file
                      </a>
                      .
                    </p>
                  )}
                  <pre className="max-h-[74dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--border-base)] bg-[var(--background-base)] p-3 font-mono text-xs text-[var(--text-base)]">
                    {text}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
