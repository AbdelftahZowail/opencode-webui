import { useEffect, useState, type ReactNode } from "react";
import { ImageOff, Loader2 } from "lucide-react";
import { api } from "../api/client";
import type { FileDiffInfo } from "../api/client";
import type { DiffSource } from "../lib/sessionDiff";
import { cn } from "../lib/utils";
import { openImage } from "./ImageViewer";

/**
 * Image preview for the diff viewer's patch pane (parity R7).
 *
 * v2 shows a thumbnail for `png/jpg/jpeg/webp/gif` changes, enlarges it on
 * click, says "unavailable" for committed images (the historical blob is not
 * fetched), and gives deleted images their own note
 * (`diff-viewer-image.tsx:9-11`). We render the *working copy* for the
 * turn/working/branch sources via a one-shot `/api/fs/read` (the same idiom as
 * the transcript's `PathImage`), and never read bytes for `committed`.
 *
 * Presentational except for the one-shot content read: `openImage` is the
 * enlarge seam and `loadSrc` is the fetch seam, both overridable.
 */
export interface DiffImagePaneProps {
  file: string;
  status: FileDiffInfo["status"];
  source: DiffSource;
  /** Session directory used to resolve a relative path (`location[directory]`). */
  location?: string | null;
  /** Consulted over the built-in `/api/fs/read` read. */
  loadSrc?: (file: string) => Promise<string>;
  /** Consulted over `openImage` — the click-to-enlarge seam. */
  onEnlarge?: (src: string, alt?: string, name?: string) => void;
  className?: string;
}

export function DiffImagePane(props: DiffImagePaneProps) {
  const { file, status, source, location, loadSrc, onEnlarge, className } = props;
  // A committed image lives in a historical blob we do not fetch — v2 says so.
  const unavailable = source === "committed";
  const deleted = status === "deleted";
  const shouldLoad = !unavailable && !deleted;

  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    let created: string | null = null;
    setSrc(null);
    setError(null);
    const run = async () => {
      try {
        const url = loadSrc
          ? await loadSrc(file)
          : URL.createObjectURL(
              new Blob([await api.fsReadBytes(file, location ?? undefined)]),
            );
        if (cancelled) {
          if (loadSrc && url) URL.revokeObjectURL(url);
          return;
        }
        created = loadSrc ? null : url;
        setSrc(url);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [file, location, shouldLoad, loadSrc]);

  const enlarge = onEnlarge ?? openImage;

  if (unavailable) {
    return (
      <ImageNote className={className} state="unavailable">
        <ImageOff className="size-4" />
        <span>Image preview unavailable for committed changes.</span>
      </ImageNote>
    );
  }

  if (deleted) {
    return (
      <ImageNote className={className} state="deleted">
        <ImageOff className="size-4" />
        <span>This image was deleted in this change.</span>
      </ImageNote>
    );
  }

  if (error) {
    return (
      <ImageNote className={className} state="error">
        <ImageOff className="size-4" />
        <span>Preview unavailable: {error}</span>
      </ImageNote>
    );
  }

  if (!src) {
    return (
      <ImageNote className={className} state="loading">
        <Loader2 className="size-4 animate-spin" />
        <span>Loading image…</span>
      </ImageNote>
    );
  }

  const name = file.split("/").pop() ?? file;
  return (
    <div
      data-oc-diff-image={file}
      className={cn("flex flex-col items-start gap-2 p-4", className)}
    >
      <button
        type="button"
        title="Click to enlarge"
        onClick={() => enlarge(src, name, name)}
        className="cursor-zoom-in overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-1 transition-colors hover:border-[var(--border-selected)]"
      >
        <img
          src={src}
          alt={`${status} image ${file}`}
          draggable={false}
          className="max-h-[60vh] max-w-full object-contain"
        />
      </button>
      <span className="text-[11px] text-[var(--text-weaker)]">
        {name} · click to enlarge
      </span>
    </div>
  );
}

function ImageNote({
  children,
  className,
  state,
}: {
  children: ReactNode;
  className?: string;
  state: "unavailable" | "deleted" | "error" | "loading";
}) {
  return (
    <div
      data-oc-diff-image-note={state}
      className={cn(
        "flex items-center gap-2 p-4 text-xs text-[var(--text-weak)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
