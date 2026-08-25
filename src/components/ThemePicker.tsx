import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { THEMES, applyTheme, getTheme } from "../theme/themes";
import { useStore } from "../store";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function ThemePicker() {
  const [current, setCurrent] = useState(getTheme().id);
  const signal = useStore((s) => s.uiSignals.themes);
  const [open, setOpen] = useState(false);

  // /themes requests this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  const label = THEMES.find((t) => t.id === current)?.label ?? THEMES[0]!.label;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
          <Palette />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            className="justify-between"
            onSelect={() => setCurrent(applyTheme(t.id).id)}
          >
            <span>{t.label}</span>
            {t.id === current && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
