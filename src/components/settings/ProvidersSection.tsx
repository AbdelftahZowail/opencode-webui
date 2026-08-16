import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ProviderInfo } from "../../api/client";
import { api } from "../../api/client";
import { Empty, ErrorNote, SectionHeader, preCls, useAsync } from "./shared";

export function ProvidersSection() {
  const { data, error, loading, refresh } = useAsync(() => api.providerList().then((r) => r.data));
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProviderInfo | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  return (
    <div>
      <SectionHeader
        title="Providers"
        note="Registered model providers"
        onRefresh={refresh}
        loading={loading}
      />
      {error && <ErrorNote message={error} />}
      {!error && data && data.length === 0 && <Empty>No providers registered.</Empty>}
      <div className="space-y-1">
        {data?.map((p) => (
          <div key={p.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-raised-base-hover)]"
              onClick={() => {
                if (open === p.id) {
                  setOpen(null);
                  setDetail(null);
                  return;
                }
                setOpen(p.id);
                setDetail(null);
                setDetailError(null);
                api
                  .providerGet(p.id)
                  .then((r) => setDetail(r.data))
                  .catch((e: unknown) =>
                    setDetailError(e instanceof Error ? e.message : String(e)),
                  );
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ChevronRight
                  className={`size-3.5 shrink-0 text-[var(--text-weaker)] transition-transform ${open === p.id ? "rotate-90" : ""}`}
                />
                <span className="truncate text-[13px] text-[var(--text-strong)]">{p.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-weaker)]">
                  {p.id}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {p.disabled && (
                  <span className="rounded border border-[var(--border-weak-base)] px-1.5 py-0.5 text-[10px] text-[var(--text-weaker)]">
                    disabled
                  </span>
                )}
                <span className="max-w-48 truncate font-mono text-[10px] text-[var(--text-weak)]">
                  {p.package}
                </span>
              </div>
            </button>
            {open === p.id && (
              <div className="mt-1 ml-4 space-y-1.5 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2.5">
                {detailError && <ErrorNote message={detailError} />}
                {!detail && !detailError && (
                  <div className="flex items-center gap-2 text-xs text-[var(--text-weaker)]">
                    <Loader2 className="size-3.5 animate-spin" /> loading…
                  </div>
                )}
                {detail && (
                  <>
                    {detail.integrationID && (
                      <p className="text-[11px] text-[var(--text-weak)]">
                        integration:{" "}
                        <span className="font-mono text-[var(--text-base)]">
                          {detail.integrationID}
                        </span>
                      </p>
                    )}
                    {detail.settings && Object.keys(detail.settings).length > 0 && (
                      <pre className={preCls}>{JSON.stringify(detail.settings, null, 2)}</pre>
                    )}
                    {detail.headers && Object.keys(detail.headers).length > 0 && (
                      <pre className={preCls}>{JSON.stringify(detail.headers, null, 2)}</pre>
                    )}
                    {detail.body && Object.keys(detail.body).length > 0 && (
                      <pre className={preCls}>{JSON.stringify(detail.body, null, 2)}</pre>
                    )}
                    {(!detail.settings || Object.keys(detail.settings).length === 0) &&
                      (!detail.headers || Object.keys(detail.headers).length === 0) &&
                      (!detail.body || Object.keys(detail.body).length === 0) && (
                        <p className="text-xs text-[var(--text-weaker)]">No settings.</p>
                      )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
