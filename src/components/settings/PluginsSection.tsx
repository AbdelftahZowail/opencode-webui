import { Puzzle } from "lucide-react";
import { api } from "../../api/client";
import { Empty, ErrorNote, SectionHeader, useAsync } from "./shared";

export function PluginsSection() {
  const { data, error, loading, refresh } = useAsync(() =>
    api.pluginList().then((r) => r.data),
  );

  return (
    <div>
      <SectionHeader
        title="Plugins"
        note="Read-only — installed plugins"
        onRefresh={refresh}
        loading={loading}
      />
      {error && <ErrorNote message={error} />}
      {!error && data && data.length === 0 && <Empty>No plugins installed.</Empty>}
      <div className="space-y-1">
        {data?.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-1.5"
          >
            <Puzzle className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
            <span className="min-w-0 truncate font-mono text-xs text-[var(--text-strong)]">
              {p.id}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
