import { useState } from "react";
import { Search } from "lucide-react";
import type { WebSearchResponse } from "../../api/client";
import { api } from "../../api/client";
import { Button } from "../ui/button";
import { Empty, ErrorNote, SectionHeader, inputCls, useAsync } from "./shared";

export function WebsearchSection() {
  const { data, error, loading, refresh } = useAsync(() =>
    api.websearchProviders().then((r) => r.data),
  );
  const [providerID, setProviderID] = useState<string>("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<WebSearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const effectiveProvider = providerID || data?.[0]?.id || "";

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader
          title="Websearch"
          note="Test search providers"
          onRefresh={refresh}
          loading={loading}
        />
        {error && <ErrorNote message={error} />}
        {!error && data && data.length === 0 && <Empty>No websearch providers available.</Empty>}
        <div className="space-y-1">
          {data?.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs text-[var(--text-strong)]">{p.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-weaker)]">
                  {p.id}
                </span>
              </div>
              <Button
                size="xs"
                variant={providerID === p.id ? "default" : "outline"}
                onClick={() => setProviderID(providerID === p.id ? "" : p.id)}
              >
                {providerID === p.id ? "selected" : "select"}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {data && data.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              className={`${inputCls} h-8 flex-1`}
              placeholder="Search query…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim() && !busy) runSearch();
              }}
            />
            <Button
              variant="default"
              disabled={!query.trim() || busy || !effectiveProvider}
              onClick={runSearch}
            >
              <Search />
              {busy ? "Searching…" : "Search"}
            </Button>
          </div>
          {!effectiveProvider && (
            <p className="text-[11px] text-[var(--text-weaker)]">Select a provider to search.</p>
          )}
          {searchError && <ErrorNote message={searchError} />}
          {result && (
            <div className="space-y-1">
              <p className="text-[11px] text-[var(--text-weaker)]">
                {result.results.length} results · provider {result.providerID}
              </p>
              {result.results.length === 0 && <Empty>No results.</Empty>}
              {result.results.map((r, i) => (
                <div
                  key={`${r.url}:${i}`}
                  className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-2"
                >
                  <a
                    className="block truncate text-xs text-[var(--text-interactive-base)] underline underline-offset-2"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.title ?? r.url}
                  </a>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-weak)]">
                    {r.content}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-weaker)]">
                    {r.url}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-2">
        <p className="text-[11px] text-[var(--text-weaker)]">
          Searching with{" "}
          <span className="font-mono text-[var(--text-base)]">
            {data?.find((p) => p.id === effectiveProvider)?.name ?? effectiveProvider}
          </span>
        </p>
      </div>
    </div>
  );

  function runSearch() {
    if (!query.trim() || busy) return;
    setBusy(true);
    setSearchError(null);
    api
      .websearch(query.trim(), effectiveProvider)
      .then((r) => setResult(r.data))
      .catch((e: unknown) => setSearchError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }
}
