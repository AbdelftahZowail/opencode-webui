import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { File, Folder } from "lucide-react";
import { api } from "../api/client";
import type { FsEntry } from "../api/client";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

interface FilePickerProps {
  open: boolean;
  query: string;
  location?: string;
  onOpenChange: (open: boolean) => void;
  onPick: (file: FsEntry) => void;
  children: ReactNode;
}

export function FilePicker({ open, query, location, onOpenChange, onPick, children }: FilePickerProps) {
  const [results, setResults] = useState<FsEntry[]>([]);
  const [resolvedLocation, setResolvedLocation] = useState<string | undefined>(location);

  useEffect(() => {
    if (open && !location && !resolvedLocation) {
      void api
        .location()
        .then((loc) => setResolvedLocation(loc.directory))
        .catch(() => undefined);
    }
  }, [open, location, resolvedLocation]);

  useEffect(() => {
    if (!open) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .fsFind(query, { location: resolvedLocation, limit: 20 })
        .then((res) => {
          if (!cancelled) setResults(res.data);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, resolvedLocation]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandList>
            {results.length > 0 && (
              <CommandGroup heading="Files">
                {results.map((entry) => (
                  <CommandItem key={entry.path} value={entry.path} onSelect={() => onPick(entry)}>
                    {entry.type === "directory" ? (
                      <Folder className="text-[color:var(--text-weak)]" />
                    ) : (
                      <File className="text-[color:var(--text-weak)]" />
                    )}
                    <span className="font-mono text-[color:var(--text-strong)]">{entry.path}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {results.length === 0 && <CommandEmpty>No matching files</CommandEmpty>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
