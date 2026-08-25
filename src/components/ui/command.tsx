"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group"
import { SearchIcon } from "lucide-react"

type CommandContextValue = {
  query: string
  setQuery: (v: string) => void
  rootRef: React.RefObject<HTMLDivElement | null>
  activeIndex: number
  setActiveIndex: (i: number) => void
  selectActive: () => void
}

const CommandContext = React.createContext<CommandContextValue | null>(null)

function useCommandContext(): CommandContextValue {
  const ctx = React.useContext(CommandContext)
  if (!ctx) throw new Error("Command components must be used inside <Command>")
  return ctx
}

// ---- imperative control -----------------------------------------------------
//
// Menus built on <Command> are driven from the text surface that owns them
// (composer textarea, file-picker mention query, palette input): their keydown
// handlers call commandMove()/commandSelectActive(), so arrow/enter keys are
// handled deterministically where they originate instead of through a global
// document listener (which double-fired with composer handling). Exactly one
// Command is live per open menu.

interface CommandHandle {
  move: (delta: 1 | -1) => void
  selectActive: () => void
}

let lastCommand: CommandHandle | null = null

/** Move the highlight of the live Command menu (wraps at both ends). */
export function commandMove(delta: 1 | -1) {
  lastCommand?.move(delta)
}

/** Run the active row of the live Command menu (first row when untouched). */
export function commandSelectActive() {
  lastCommand?.selectActive()
}

/**
 * Visible, enabled command items in document order — the same order the user
 * sees. Queried from the DOM at call time, so filtering, mount/unmount and
 * even StrictMode's double-mounted effects can never desync the highlight
 * from the rendered rows (the old index-registration approach accumulated
 * stale entries on remount, which is why the highlight only appeared after
 * a full loop through the menu).
 */
function visibleItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).filter(
    (el) => el.dataset.disabled !== "true",
  )
}

function Command({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const rootRef = React.useRef<HTMLDivElement>(null)

  const selectActive = React.useCallback(() => {
    const items = visibleItems(rootRef.current)
    if (items.length === 0) return
    // Nothing highlighted yet (menu just opened): select the first row,
    // matching upstream's autocomplete where submit takes the top hit.
    const active = activeIndex >= 0 && activeIndex < items.length ? items[activeIndex] : items[0]
    active?.click()
  }, [activeIndex])

  const ctx = React.useMemo<CommandContextValue>(
    () => ({ query, setQuery, rootRef, activeIndex, setActiveIndex, selectActive }),
    [query, activeIndex, selectActive],
  )

  // The handle is created ONCE and always reads live state through a ref —
  // key-repeat (≈33ms apart) can fire before the passive effect that swaps
  // lastCommand runs, so closures must never carry stale activeIndex.
  const stateRef = React.useRef({ activeIndex, setActiveIndex, selectActive })
  stateRef.current = { activeIndex, setActiveIndex, selectActive }

  const handle = React.useMemo<CommandHandle>(
    () => ({
      move(delta) {
        const s = stateRef.current
        const items = visibleItems(rootRef.current)
        if (items.length === 0) return
        const len = items.length
        // A stale index (the list shrank since the last move) counts as
        // "nothing selected": ↓ takes the first row, ↑ the last.
        const i = s.activeIndex >= 0 && s.activeIndex < len ? s.activeIndex : -1
        s.setActiveIndex(delta === 1 ? (i + 1) % len : i <= 0 ? len - 1 : i - 1)
      },
      selectActive() {
        stateRef.current.selectActive()
      },
    }),
    [],
  )

  React.useEffect(() => {
    lastCommand = handle
    return () => {
      if (lastCommand === handle) lastCommand = null
    }
  }, [handle])

  React.useEffect(() => {
    const active = visibleItems(rootRef.current)[activeIndex]
    active?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  return (
    <CommandContext.Provider value={ctx}>
      <div
        ref={rootRef}
        data-slot="command"
        className={cn(
          "flex size-full flex-col overflow-hidden rounded-xl! bg-popover p-1 text-popover-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </CommandContext.Provider>
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0",
          className,
        )}
        showCloseButton={showCloseButton}
      >
        <Command className="[&_[data-slot=command-group-heading]]:px-2 [&_[data-slot=command-group-heading]]:font-medium [&_[data-slot=command-group-heading]]:text-muted-foreground [&_[data-slot=command-group]]:px-2 [&_[data-slot=command-input-wrapper]_svg]:size-5 [&_[data-slot=command-input]]:h-12 [&_[data-slot=command-item]]:px-2 [&_[data-slot=command-item]]:py-3 [&_[data-slot=command-item]_svg]:size-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  value,
  onValueChange,
  ...props
}: React.ComponentProps<"input"> & {
  onValueChange?: (value: string) => void
}) {
  const ctx = useCommandContext()
  const isControlled = value !== undefined
  const displayValue = isControlled ? value : ctx.query

  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <InputGroupAddon className="[&_svg]:size-4 shrink-0 [&_svg]:text-muted-foreground">
        <SearchIcon />
      </InputGroupAddon>
      <InputGroup>
        <input
          data-slot="command-input"
          className={cn(
            "flex h-9 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          value={displayValue}
          onChange={(e) => {
            const next = e.target.value
            if (!isControlled) ctx.setQuery(next)
            onValueChange?.(next)
          }}
          {...props}
        />
      </InputGroup>
    </div>
  )
}

function CommandList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="command-list"
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden p-1",
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const ctx = useCommandContext()
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => setTick((t) => t + 1), [ctx.query])

  const q = ctx.query.trim().toLowerCase()
  const hasVisible = React.useMemo(() => {
    const root = document.querySelector("[data-slot=command]")
    if (!root) return true
    return [...root.querySelectorAll<HTMLElement>("[data-slot=command-item]")].some(
      (el) => !q || (el.dataset.value ?? "").toLowerCase().includes(q),
    )
  }, [ctx.query, tick])

  if (hasVisible) return null

  return (
    <div
      data-slot="command-empty"
      className={cn("py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  heading,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { heading?: React.ReactNode }) {
  const ctx = useCommandContext()
  const groupRef = React.useRef<HTMLDivElement>(null)

  const hasVisible = React.useMemo(() => {
    const q = ctx.query.trim().toLowerCase()
    if (!groupRef.current) return true
    return [...groupRef.current.querySelectorAll<HTMLElement>("[data-slot=command-item]")].some(
      (el) => !q || (el.dataset.value ?? "").toLowerCase().includes(q),
    )
  }, [ctx.query])

  if (!hasVisible) return null

  return (
    <div
      ref={groupRef}
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[data-slot=command-group-heading]]:px-2 **:[[data-slot=command-group-heading]]:py-1.5 **:[[data-slot=command-group-heading]]:text-xs **:[[data-slot=command-group-heading]]:font-medium **:[[data-slot=command-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {heading !== undefined && (
        <div data-slot="command-group-heading" className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {heading}
        </div>
      )}
      {children}
    </div>
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-separator"
      className={cn("h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  value,
  disabled,
  onSelect,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  value?: string
  disabled?: boolean
  onSelect?: () => void
}) {
  const ctx = useCommandContext()
  const ref = React.useRef<HTMLDivElement>(null)
  // Position among the RENDERED items, derived from the live DOM after every
  // commit (no registration lifecycle, so remounts/StrictMode can't desync it).
  const [index, setIndex] = React.useState(-1)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el || !ctx.rootRef.current) {
      setIndex(-1)
      return
    }
    const items = ctx.rootRef.current.querySelectorAll(
      '[data-slot="command-item"]:not([data-disabled="true"])',
    )
    setIndex(Array.prototype.indexOf.call(items, el))
  })

  const isActive = !disabled && index >= 0 && index === ctx.activeIndex
  const itemValue = value ?? ref.current?.textContent ?? ""

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (isActive) {
      el.dataset.selected = "true"
      el.dataset.state = "active"
      el.setAttribute("aria-selected", "true")
    } else {
      delete el.dataset.selected
      el.dataset.state = ""
      el.setAttribute("aria-selected", "false")
    }
  }, [isActive])

  const query = ctx.query.trim().toLowerCase()
  if (query && !itemValue.toLowerCase().includes(query)) return null

  return (
    <div
      ref={ref}
      data-slot="command-item"
      data-value={itemValue}
      role="option"
      aria-selected={isActive}
      data-disabled={disabled || undefined}
      data-state={isActive ? "active" : undefined}
      onClick={() => {
        if (disabled) return
        onSelect?.()
      }}
      className={cn(
        // Keyboard-selected rows use the raised-active token — --accent maps
        // to a near-background gray here, which read as "no highlight at all".
        "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden data-[disabled=true]:pointer-events-none data-[selected=true]:bg-[color:var(--surface-raised-base-active)] data-[selected=true]:text-[color:var(--text-strong)] data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
