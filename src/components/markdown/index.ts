/**
 * Markdown core — the transcript's markdown renderer and its parts.
 *
 * `Markdown` is the one entry point; the rest are the pieces it composes
 * (tables, live tilde-fence previews, shelf chips, the preview pause control).
 */
export { Markdown } from "./Markdown";
export { Table, Th, Td } from "./Table";
export { ShelfChip } from "./ShelfChip";
export { PreviewBlock, PreviewPausedBlock } from "./PreviewBlock";
export { getLiveFence, type LiveFenceInfo, type LiveKind } from "./fence";
export {
  isMarkdownRenderingEnabled,
  setMarkdownRendering,
  subscribeMarkdownRendering,
  useMarkdownRendering,
} from "./controls";
