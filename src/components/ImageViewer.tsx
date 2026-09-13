import { useEffect, useState } from "react";
import { ExternalLink, X } from "lucide-react";

/**
 * Transcript image viewer.
 *
 * Clicking any image in the transcript (attachment thumbnail, tool image, or
 * markdown `![]()`) opens it here — a normal full-viewport viewer with the
 * image at natural size, Esc/backdrop to close, and an "open in new tab"
 * affordance for real URLs (data: URIs cannot be navigated to top-level).
 *
 * One instance is mounted app-wide; callers just dispatch `openImage`.
 */
const OPEN_EVENT = "opencode:open-image";

interface ImagePayload {
  src: string;
  alt?: string;
  name?: string;
}

/** Open the full image viewer with this source. */
export function openImage(src: string, alt?: string, name?: string): void {
  if (typeof window === "undefined" || !src) return;
  window.dispatchEvent(new CustomEvent<ImagePayload>(OPEN_EVENT, { detail: { src, alt, name } }));
}

export function ImageViewer() {
  const [img, setImg] = useState<ImagePayload | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<ImagePayload>).detail;
      if (detail?.src) setImg(detail);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!img) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Beat the site-wide Esc/interrupt binding while the viewer is up.
      e.preventDefault();
      e.stopPropagation();
      setImg(null);
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [img]);

  if (!img) return null;
  const label = img.alt ?? img.name ?? "image";
  // data:/blob: URLs can't be opened as a top-level document in most browsers.
  const openable = !/^(data|blob):/i.test(img.src);

  const iconBtn =
    "flex size-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur transition-colors hover:bg-black/70 hover:text-white";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={() => setImg(null)}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
    >
      <img
        src={img.src}
        alt={label}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] max-w-[94vw] rounded-md object-contain shadow-2xl"
      />
      <div
        className="absolute top-4 right-4 flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        {openable && (
          <a
            href={img.src}
            target="_blank"
            rel="noreferrer"
            title="Open in new tab"
            aria-label="Open in new tab"
            className={iconBtn}
          >
            <ExternalLink className="size-4" />
          </a>
        )}
        <button type="button" onClick={() => setImg(null)} title="Close (Esc)" aria-label="Close" className={iconBtn}>
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
