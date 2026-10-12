/**
 * Tool diagnostics (parity R10) — the "up to 3 severity-1 errors" the TUI
 * shows under a completed `write`/`edit` (`routes/session/index.tsx:3520-3544`).
 *
 * ENGINE SHAPE (recorded because it is NOT in the OpenAPI snapshot):
 * tool `metadata` is free-form, so diagnostics may arrive as an array, a
 * by-file map, or embedded in the tool's text output depending on how the
 * language server integration reports them. Severity may be absent entirely.
 * We therefore normalize defensively and, when severity is missing, treat the
 * entry as an error-level diagnostic (severity 1) — matching the TUI's
 * "errors only" intent rather than hiding it. `source` is kept for display.
 *
 * Severity numbering follows LSP: 1 error, 2 warning, 3 information, 4 hint.
 */

export interface ToolDiagnostic {
  /** 1=error, 2=warning, 3=info, 4=hint. Missing severity → 1. */
  severity: number;
  message: string;
  source?: string;
  file?: string;
  line?: number;
  column?: number;
}

const SEVERITY_NAMES: Record<string, number> = {
  error: 1,
  warning: 2,
  warn: 2,
  info: 3,
  information: 3,
  hint: 4,
};

function normalizeSeverity(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1 && value <= 4) return Math.round(value);
    return 1;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 4) return Math.round(numeric);
    const named = SEVERITY_NAMES[value.toLowerCase()];
    if (named !== undefined) return named;
  }
  // Severity not available — treat as an error so it is not silently dropped.
  return 1;
}

function numOrUndef(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toDiagnostic(item: unknown): ToolDiagnostic | undefined {
  if (!item || typeof item !== "object") return undefined;
  const o = item as Record<string, unknown>;
  const message =
    typeof o.message === "string"
      ? o.message
      : typeof o.text === "string"
        ? o.text
        : typeof o.description === "string"
          ? o.description
          : undefined;
  if (!message) return undefined;
  const range = o.range as { start?: { line?: number; character?: number } } | undefined;
  return {
    severity: normalizeSeverity(o.severity ?? o.level),
    message,
    source: typeof o.source === "string" ? o.source : undefined,
    file: typeof o.file === "string" ? o.file : typeof o.path === "string" ? o.path : undefined,
    line: numOrUndef(o.line) ?? numOrUndef(range?.start?.line),
    column: numOrUndef(o.column) ?? numOrUndef(o.character) ?? numOrUndef(range?.start?.character),
  };
}

/** `path:line:col: error: message` / `path:line - warning message` text lines. */
const DIAG_LINE =
  /^\s*([^\s:][^:]*?):(\d+)(?::(\d+))?\s*[-:]?\s+(error|warning|warn|info|information|hint)\b[:]?\s*(.*)$/i;

function parseDiagnosticsText(text: string): ToolDiagnostic[] {
  const out: ToolDiagnostic[] = [];
  for (const raw of text.split("\n")) {
    const match = DIAG_LINE.exec(raw);
    if (!match) continue;
    const [, file, line, column, severity, message] = match;
    if (!message || !message.trim()) continue;
    out.push({
      severity: normalizeSeverity(severity),
      message: message.trim(),
      file,
      line: numOrUndef(line),
      column: numOrUndef(column),
    });
  }
  return out;
}

/**
 * Extract diagnostics from a tool's metadata (array, single object, or a
 * file→list map) and, when none are found there, from its text output.
 */
export function extractDiagnostics(
  meta: Record<string, unknown>,
  output?: string,
): ToolDiagnostic[] {
  const raw =
    meta.diagnostics ??
    meta.diagnostic ??
    (meta.lsp as { diagnostics?: unknown } | undefined)?.diagnostics;
  const out: ToolDiagnostic[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const d = toDiagnostic(item);
      if (d) out.push(d);
    }
  } else if (raw && typeof raw === "object") {
    for (const [file, list] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const d = toDiagnostic(item);
        if (d) out.push({ ...d, file: d.file ?? file });
      }
    }
  } else if (!raw && output) {
    out.push(...parseDiagnosticsText(output));
  }
  return out;
}

/** The first `max` error-level (severity 1) diagnostics — the TUI's cap. */
export function errorDiagnostics(diagnostics: ToolDiagnostic[], max = 3): ToolDiagnostic[] {
  return diagnostics.filter((d) => d.severity === 1).slice(0, max);
}
