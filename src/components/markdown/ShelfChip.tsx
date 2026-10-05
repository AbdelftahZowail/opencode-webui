/**
 * Shelf link chip — a markdown link whose href starts with the FROZEN
 * `/api/shelf/file/` prefix renders as a small inline chip (file icon +
 * filename/kind) instead of a raw URL or a full link.
 *
 * The prefix is owned by the core shelf (`src/components/shelf/shelfApi.ts`,
 * `server/shelf.ts`); this module only recognizes it. Click opens in a new tab.
 * Extension icons/kind labels are re-derived here from the path so the chip
 * needs no listing request and works for a link that points at a file the
 * listing has not caught up with.
 */
import { FileText, FileType2, Film, Image as ImageIcon, Music, Paperclip, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** The one frozen prefix this chip owns. */
const SHELF_PREFIX = "/api/shelf/file/";

function decodePath(href: string): string {
  const raw = href.slice(SHELF_PREFIX.length).split(/[?#]/)[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const KIND_ICON: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  pdf: FileType2,
  text: FileText,
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);

/** Derive an icon from the extension alone (no listing round-trip). */
function iconFor(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (IMAGE_EXT.has(ext)) return KIND_ICON.image!;
  if (ext === ".pdf") return KIND_ICON.pdf!;
  if ([".mp4", ".webm", ".mov", ".m4v", ".ogv"].includes(ext)) return KIND_ICON.video!;
  if ([".mp3", ".m4a", ".wav", ".flac", ".ogg", ".oga"].includes(ext)) return KIND_ICON.audio!;
  if ([".txt", ".log", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml"].includes(ext)) {
    return KIND_ICON.text!;
  }
  return Paperclip;
}

function kindLabelFor(name: string): string {
  const icon = iconFor(name);
  if (icon === KIND_ICON.image) return "Image";
  if (icon === KIND_ICON.pdf) return "PDF";
  if (icon === KIND_ICON.video) return "Video";
  if (icon === KIND_ICON.audio) return "Audio";
  if (icon === KIND_ICON.text) return "Text";
  return "File";
}

export function ShelfChip({ href, children }: { href: string; children?: ReactNode }) {
  const path = decodePath(href);
  const name = path.split("/").pop() || path || "file";
  const Icon = iconFor(name);
  const kind = kindLabelFor(name);
  // The link text may be an arbitrary label; the chip shows the real filename.
  const label = name;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      data-oc-shelf-chip
      title={`${path} · ${kind} — open in a new tab`}
      className="mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-1.5 py-0.5 align-middle text-[0.85em] text-[var(--text-base)] no-underline transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
    >
      <Icon className="size-3 shrink-0 text-[var(--text-weak)]" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-weaker)]">{kind}</span>
      {/* `children` carries the original markdown label; kept for a11y/search
          without changing the visible chip (which always names the file). */}
      <span className="sr-only">{children}</span>
    </a>
  );
}
