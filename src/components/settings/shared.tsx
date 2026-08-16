import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui/button";

export const inputCls =
  "w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--input-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)] focus:ring-1 focus:ring-[var(--border-selected)]";

export const preCls =
  "max-h-56 overflow-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--text-base)]";

export const rowCls =
  "flex items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2";

export function SectionHeader({
  title,
  note,
  onRefresh,
  loading,
}: {
  title: string;
  note?: string;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="shrink-0 text-[13px] font-medium text-[var(--text-strong)]">{title}</h3>
        {note && <span className="truncate text-[11px] text-[var(--text-weaker)]">{note}</span>}
      </div>
      {onRefresh && (
        <Button variant="ghost" size="icon-sm" title="Refresh" disabled={loading} onClick={onRefresh}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-center text-xs text-[var(--text-weaker)]">{children}</p>;
}

export function useAsync<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refresh };
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-[var(--surface-critical-base)] bg-[var(--surface-critical-weak)] px-2.5 py-1.5 text-xs text-[var(--surface-critical-strong)]">{message}</p>;
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </Button>
  );
}
