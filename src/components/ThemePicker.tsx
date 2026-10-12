import { useEffect, useState } from "react";
import { Check, Palette } from "lucide-react";
import { getTheme, listAllThemes, selectTheme, subscribeTheme } from "../theme/themes";
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
  // Built-in + discovered custom themes; refreshed on any theme change.
  const [themes, setThemes] = useState(() => listAllThemes());
  const signal = useStore((s) => s.uiSignals.themes);
  const [open, setOpen] = useState(false);

  // /themes requests this picker to open.
  useEffect(() => {
    if (signal) setOpen(true);
  }, [signal]);

  // Repaint the active marker and the list when the theme changes (custom
  // themes load at boot and from Settings › Appearance).
  useEffect(
    () =>
      subscribeTheme(() => {
        setCurrent(getTheme().id);
        setThemes(listAllThemes());
      }),
    [],
  );

  const label = themes.find((t) => t.id === current)?.label ?? themes[0]?.label ?? "Theme";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
          <Palette />
          {/* Below lg: icon-only so the session title keeps its room. */}
          <span className="hidden lg:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        {themes.map((t) => (
          <DropdownMenuItem
            key={t.id}
            className="justify-between"
            onSelect={() => setCurrent(selectTheme(t.id).id)}
          >
            <span>{t.label}</span>
            {t.id === current && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
