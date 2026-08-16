import type { ConfigEntry } from "../../api/client";
import { api } from "../../api/client";
import { Badge } from "../ui";
import { Empty, ErrorNote, SectionHeader, preCls, useAsync } from "./shared";

export function ConfigSection() {
  const { data, error, loading, refresh } = useAsync(() => api.configGet());

  return (
    <div>
      <SectionHeader
        title="Configuration"
        note="Read-only — edit server-side in opencode.jsonc"
        onRefresh={refresh}
        loading={loading}
      />
      {error && <ErrorNote message={error} />}
      {!error && data && data.length === 0 && <Empty>No configuration found.</Empty>}
      <div className="space-y-2">
        {data?.map((entry, i) => (
          <ConfigEntryView key={i} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function ConfigEntryView({ entry }: { entry: ConfigEntry }) {
  return (
    <div className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-2.5">
      <div className="flex items-center gap-2">
        <Badge tone={entry.type === "document" ? "blue" : "neutral"}>{entry.type}</Badge>
        {entry.path && (
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--text-weak)]">
            {entry.path}
          </span>
        )}
      </div>
      {entry.type === "document" && (
        <pre className={`${preCls} mt-2 max-h-72`}>{JSON.stringify(entry.info, null, 2)}</pre>
      )}
    </div>
  );
}
