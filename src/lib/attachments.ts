/**
 * Image attachment helpers (pure transforms only — no store, no fetch).
 *
 * Contract facts (docs/reference/openapi.json + @opencode-ai/client types):
 * - POST /session/{id}/prompt accepts files as PromptInput.FileAttachment =
 *   {uri, name?, description?, mention?} — uri is a plain string, and the
 *   engine resolves `data:` URLs (the TUI pastes images exactly this way:
 *   `data:${mime};base64,${bytes}`), so pasted images ride the existing
 *   uri-only field with no extra endpoint.
 * - History UserMessage.files are Prompt.FileAttachment = {data: base64,
 *   mime, source: {type:"inline"} | {type:"uri", uri}, name?, ...}.
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

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

export function isImageMime(mime: string | undefined | null): boolean {
  return !!mime && mime.startsWith("image/");
}

export function looksLikeImagePath(path: string | undefined | null): boolean {
  if (!path) return false;
  return IMAGE_EXT.test(path.split("?")[0] ?? "");
}

export function isImageFile(file: File): boolean {
  return isImageMime(file.type) || looksLikeImagePath(file.name);
}

/** File → PendingAttachment via FileReader (no dependency on URLs). */
export function fileToAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.onload = () => {
      const uri = String(reader.result ?? "");
      if (!uri.startsWith("data:")) {
        reject(new Error(`unexpected read result for ${file.name}`));
        return;
      }
      resolve({
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || "image",
        mime: file.type || mimeFromName(file.name) || "application/octet-stream",
        uri,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Convert every image file; non-images resolve to null and are dropped. */
export async function imagesToAttachments(files: Iterable<File>): Promise<PendingAttachment[]> {
  const out: PendingAttachment[] = [];
  for (const file of Array.from(files)) {
    if (!isImageFile(file)) continue;
    try {
      out.push(await fileToAttachment(file));
    } catch {
      /* unreadable file — skip it */
    }
  }
  return out;
}

/** The wire shape for the prompt endpoint's uri-only files field. */
export function attachmentPromptFile(att: PendingAttachment): PromptFile {
  return { uri: att.uri, name: att.name };
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

/** ArrayBuffer → base64, chunked so large images don't blow the call stack. */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
