/**
 * Image attachment helpers (pure transforms only — no store, no fetch).
 *
 * Contract facts (docs/reference/openapi.json + @opencode-ai/client types):
 * - POST /session/{id}/prompt accepts files as PromptInput.FileAttachment =
 *   {uri, name?, description?, mention?} — uri is a plain string, and the
 *   engine resolves `data:` URLs (the TUI pastes images exactly this way:
 *   `data:${mime};base64,${bytes}`), so pasted images ride the existing
 *   uri-only field with no extra endpoint.
 * - The engine only turns a subset of mime types into prompt content
 *   (`oo` in the engine's prompt lowering): `text/plain` (inlined),
 *   `application/x-directory` (listing), and — as real media —
 *   `image/png|jpeg|gif|webp` plus `application/pdf`. Every other mime is
 *   silently DROPPED. We therefore only offer the engine-supported images
 *   here; anything else is reported back to the user instead of staged.
 * - History UserMessage.files are Prompt.FileAttachment = {data: base64,
 *   mime, source: {type:"inline"} | {type:"uri", uri}, name?, ...}.
 * - The engine normalizes images to at most 2000×2000 / 5 MiB of base64
 *   (opencode `image.auto_resize`/`max_width`/`max_height`/
 *   `max_base64_bytes` defaults). We mirror those defaults client-side so a
 *   huge paste is downscaled before it crosses the wire and never trips the
 *   engine's "Image is too large" path.
 */

import type { FileAttachment } from "../api/types";
import type { PromptFile } from "../api/client";

/** An image staged in the composer, not yet sent. */
export interface PendingAttachment {
  id: string;
  /** Display name (file name for drops/pastes). */
  name: string;
  mime: string;
  /** data: URI carrying the base64 bytes — sent verbatim as PromptFile.uri. */
  uri: string;
}

/**
 * Mime types the engine actually converts into media content. Keep in sync
 * with the engine's attachment lowering — a wider list here means silently
 * dropped attachments.
 */
export const ENGINE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const ENGINE_IMAGE_MIME_SET: ReadonlySet<string> = new Set(ENGINE_IMAGE_MIMES);

/** `accept` attribute for the composer's attachment file picker. */
export const ENGINE_IMAGE_ACCEPT = ENGINE_IMAGE_MIMES.join(",");

/** Engine image normalizer defaults (see header). */
export const ENGINE_IMAGE_MAX_DIM = 2000;
export const ENGINE_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function isImageMime(mime: string | undefined | null): boolean {
  return !!mime && mime.startsWith("image/");
}

export function looksLikeImagePath(path: string | undefined | null): boolean {
  if (!path) return false;
  return IMAGE_EXT.test(path.split("?")[0] ?? "");
}

/** `image/jpg` is a non-standard alias the engine folds to `image/jpeg`. */
export function normalizeImageMime(mime: string | undefined | null): string | undefined {
  if (!mime) return undefined;
  const m = mime.trim().toLowerCase();
  return m === "image/jpg" ? "image/jpeg" : m;
}

/** True when the engine will treat this mime as an image attachment. */
export function isEngineImageMime(mime: string | undefined | null): boolean {
  const m = normalizeImageMime(mime);
  return !!m && ENGINE_IMAGE_MIME_SET.has(m);
}

/**
 * Engine-supported image mime for a file name, or undefined for anything the
 * engine would drop (svg/avif/bmp/… and non-images).
 */
export function engineImageMimeFromName(name: string | undefined | null): string | undefined {
  const m = normalizeImageMime(mimeFromName(name ?? ""));
  return m && ENGINE_IMAGE_MIME_SET.has(m) ? m : undefined;
}

/** True when a browser File is an image the engine can actually consume. */
export function isEngineImageFile(file: File): boolean {
  if (isEngineImageMime(file.type)) return true;
  return !!engineImageMimeFromName(file.name);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read file"));
    reader.onload = () => {
      const uri = String(reader.result ?? "");
      if (!uri.startsWith("data:")) {
        reject(new Error("unexpected read result"));
        return;
      }
      resolve(uri);
    };
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = src;
  });
}

/**
 * Shrink a data-URI image to the engine's limits (max dimension + max base64
 * bytes). Returns the input untouched when it already fits. Animated GIFs are
 * never re-encoded (canvas would flatten them) — the engine handles those.
 */
async function fitImageToEngineLimits(
  uri: string,
  mime: string,
): Promise<{ uri: string; mime: string }> {
  const parts = splitDataUri(uri);
  if (!parts || mime === "image/gif") return { uri, mime };
  const img = await loadImageElement(uri);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const oversized =
    parts.base64.length > ENGINE_IMAGE_MAX_BASE64_BYTES ||
    width > ENGINE_IMAGE_MAX_DIM ||
    height > ENGINE_IMAGE_MAX_DIM;
  if (!oversized) return { uri, mime };

  const scale = Math.min(1, ENGINE_IMAGE_MAX_DIM / width, ENGINE_IMAGE_MAX_DIM / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return { uri, mime };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Prefer the source type; PNG stays lossless, everything else falls back to
  // JPEG (with shrinking quality) until the base64 fits the engine budget.
  const types = mime === "image/png" ? ["image/png", "image/jpeg"] : [mime, "image/jpeg"];
  let smallest: { uri: string; mime: string } | null = null;
  let matted = false;
  for (const type of types) {
    if (type === "image/jpeg" && !matted) {
      // JPEG has no alpha; composite onto white so a transparent PNG that can't
      // fit as PNG doesn't encode as a black rectangle.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
      matted = true;
    }
    for (const quality of [0.92, 0.8, 0.65]) {
      const out = canvas.toDataURL(type, quality);
      const outParts = splitDataUri(out);
      if (!outParts) continue;
      const candidate = { uri: out, mime: normalizeImageMime(type) ?? mime };
      if (!smallest || outParts.base64.length < (splitDataUri(smallest.uri)?.base64.length ?? Infinity)) {
        smallest = candidate;
      }
      if (outParts.base64.length <= ENGINE_IMAGE_MAX_BASE64_BYTES) return candidate;
    }
  }
  return smallest ?? { uri, mime };
}

/**
 * File → PendingAttachment. Throws with a user-facing reason when the file is
 * not an engine-supported image, cannot be read, or is still too large after
 * downscaling. The emitted data URI always carries an engine-accepted mime.
 */
export async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const declared = isEngineImageMime(file.type)
    ? normalizeImageMime(file.type)!
    : engineImageMimeFromName(file.name);
  if (!declared) throw new Error(`unsupported image type (${file.type || "unknown"})`);

  const raw = await readFileAsDataUrl(file);
  const rawParts = splitDataUri(raw);
  if (!rawParts) throw new Error("could not read image data");
  // Rebuild with the normalized mime so a blank/alias File.type still reaches
  // the engine as an accepted one.
  const normalized = `data:${declared};base64,${rawParts.base64}`;

  let fitted: { uri: string; mime: string };
  try {
    fitted = await fitImageToEngineLimits(normalized, declared);
  } catch {
    // Decode unavailable — send the original bytes and let the engine resize.
    fitted = { uri: normalized, mime: declared };
  }

  const parts = splitDataUri(fitted.uri);
  if (parts && parts.base64.length > ENGINE_IMAGE_MAX_BASE64_BYTES) {
    const mb = Math.round(ENGINE_IMAGE_MAX_BASE64_BYTES / (1024 * 1024));
    throw new Error(`image is too large (max ${mb} MB)`);
  }

  return {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "image",
    mime: fitted.mime,
    uri: fitted.uri,
  };
}

/** Result of staging a batch of user-provided files. */
export interface AttachmentCollection {
  attachments: PendingAttachment[];
  /** Per-file failures (unreadable / too large), ready to show the user. */
  errors: string[];
  /** Files skipped because they are not engine-supported images. */
  unsupported: number;
}

/**
 * Convert every engine-supported image in `files`; report (never silently
 * drop) files that are unsupported or unreadable.
 */
export async function collectImageAttachments(files: Iterable<File>): Promise<AttachmentCollection> {
  const attachments: PendingAttachment[] = [];
  const errors: string[] = [];
  let unsupported = 0;
  for (const file of Array.from(files)) {
    if (!isEngineImageFile(file)) {
      unsupported += 1;
      continue;
    }
    try {
      attachments.push(await fileToAttachment(file));
    } catch (err) {
      const name = file.name || "image";
      errors.push(`${name}: ${err instanceof Error ? err.message : "could not read"}`);
    }
  }
  return { attachments, errors, unsupported };
}

/** The wire shape for the prompt endpoint's uri-only files field. */
export function attachmentPromptFile(att: PendingAttachment): PromptFile {
  return { uri: att.uri, name: att.name };
}

/**
 * Optimistic history shape for a just-sent prompt's files, so the thumbnail
 * renders before the engine echoes the persisted user message back.
 */
export function promptFilesToHistory(files: PromptFile[]): FileAttachment[] {
  const out: FileAttachment[] = [];
  for (const file of files) {
    const name = file.name ?? fileNameFromUri(file.uri);
    const parts = splitDataUri(file.uri);
    if (parts) {
      out.push({
        data: parts.base64,
        mime: normalizeImageMime(parts.mime) ?? parts.mime,
        source: { type: "inline" },
        ...(name ? { name } : {}),
      });
      continue;
    }
    out.push({
      data: "",
      mime: engineImageMimeFromName(name) ?? mimeFromName(name ?? "") ?? "text/plain",
      source: { type: "uri", uri: file.uri },
      ...(name ? { name } : {}),
    });
  }
  return out;
}

function fileNameFromUri(uri: string): string | undefined {
  try {
    const path = new URL(uri).pathname;
    const base = path.split("/").pop();
    return base ? decodeURIComponent(base) : undefined;
  } catch {
    const base = uri.split("/").pop();
    return base || undefined;
  }
}

/** Split `data:<mime>;base64,<payload>` — null when not a base64 data URI. */
export function splitDataUri(uri: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (!match) return null;
  return { mime: match[1] ?? "application/octet-stream", base64: match[2] ?? "" };
}

export function mimeFromName(name: string): string | undefined {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

/**
 * Renderable image src for a HISTORY file attachment, when it can be shown
 * without any fetch: inline base64 → data URI; http(s)/blob/data source URI →
 * as-is. Path-form sources need a byte fetch — see MessageItem's
 * AttachmentImage for the blob-URL fallback.
 */
export function historyImageSrc(file: FileAttachment): string | null {
  if (!isImageMime(file.mime) && !looksLikeImagePath(file.name)) return null;
  if (file.data) {
    // Inline bytes win even when a source uri is present.
    return `data:${file.mime};base64,${file.data}`;
  }
  if (file.source?.type === "uri") {
    const uri = file.source.uri;
    if (/^(https?:|blob:|data:image\/)/i.test(uri)) return uri;
  }
  return null;
}

/** A filesystem path to try fetching bytes for (file:// URI or bare path). */
export function historyFilePath(file: FileAttachment): string | null {
  if (!isImageMime(file.mime) && !looksLikeImagePath(file.name)) return null;
  if (file.data) return null; // already renderable inline
  if (file.source?.type === "uri") {
    const uri = file.source.uri;
    if (/^file:\/\//i.test(uri)) {
      try {
        return decodeURIComponent(new URL(uri).pathname);
      } catch {
        return null;
      }
    }
    if (/^\//.test(uri) || looksLikeImagePath(uri)) return uri;
  }
  return null;
}
