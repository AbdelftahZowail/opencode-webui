import { useState } from "react";
import { Check, Palette } from "lucide-react";
import { THEMES, applyTheme, getTheme } from "../theme/themes";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function ThemePicker() {
  const [current, setCurrent] = useState(getTheme().id);
  const label = THEMES.find((t) => t.id === current)?.label ?? THEMES[0]!.label;

  return (
    <DropdownMenu>
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
