import { useState } from "react";
import { Check, Folder } from "lucide-react";
import { api, type LocationInfo, type ProjectInfo } from "../api/client";
import { useStore } from "../store";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Skeleton } from "./ui/skeleton";

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

function projectName(p: ProjectInfo): string {
  const base = baseName(p.directory ?? p.canonical);
  return base && base !== "/" ? base : p.id;
}

export function WorkspacePicker({ sessionID }: { sessionID: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID));
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [current, setCurrent] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const dir = session?.location.directory ?? location?.directory;

  function refresh() {
    setLoading(true);
    void Promise.all([api.locationInfo(), api.projectCurrent(), api.projectList()])
      .then(([loc, cur, list]) => {
        setLocation(loc);
        setCurrent(cur);
        setProjects(list);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && refresh()}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title={dir}
          className="max-w-44 text-xs text-muted-foreground"
        >
          <Folder />
          <span className="truncate font-mono">{dir ? dir : "workspace"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Location</DropdownMenuLabel>
        <div className="flex items-center gap-1.5 px-1.5 py-1 text-sm text-[var(--text-base)]">
          <Folder className="size-3.5 shrink-0 text-[var(--text-weak)]" />
          <span className="truncate font-mono text-xs">
            {location?.directory ?? dir ?? "…"}
          </span>
        </div>
        {location?.workspaceID && (
          <div className="px-1.5 pb-1 font-mono text-[11px] text-[var(--text-weaker)]">
            {location.workspaceID}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        {loading && projects.length === 0 ? (
          <div className="flex flex-col gap-1.5 px-1.5 py-1">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : projects.length === 0 ? (
          <div className="px-1.5 py-1 text-xs text-[var(--text-weaker)]">No projects</div>
        ) : (
          projects.map((p) => {
            const active = current?.id === p.id;
            return (
              <DropdownMenuItem
                key={p.id}
                className="justify-between font-mono text-xs"
                onSelect={(e) => e.preventDefault()}
              >
                <span className="truncate">{projectName(p)}</span>
                {active && <Check className="size-3.5 text-[var(--text-interactive-base)]" />}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
