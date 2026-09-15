import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2 } from "lucide-react";
import type {
  PermissionEffect,
  PermissionRule,
  PermissionRuleset,
} from "../api/types";
import { cn } from "../lib/utils";
import { autoRegister } from "../extensions/registry";
import { Button } from "./ui";
import { Input } from "./ui/input";

/**
 * Session permission rules editor (P4). Purely presentational: it owns a local
 * draft and emits it through `onSave` — the parent owns the PUT
 * (`api.sessionPermissionRules`) and the store owns all side effects.
 *
 * The engine evaluates a ruleset IN ORDER and the LAST matching rule wins, so
 * ordering is the primary affordance here: numbered, reorderable rows with an
 * explicit note.
 */
export interface PermissionRulesEditorProps {
  rules: PermissionRuleset;
  onSave: (rules: PermissionRuleset) => void;
  onCancel: () => void;
}

/** Known default actions — offered as input hints (glob-ish; `*` matches all). */
const KNOWN_ACTIONS = [
  "*",
  "read",
  "edit",
  "write",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "subagent",
  "external_directory",
  "shell",
  "bash",
] as const;

const EFFECTS: {
  value: PermissionEffect;
  label: string;
  active: string;
  dot: string;
}[] = [
  {
    value: "allow",
    label: "Allow",
    active:
      "bg-[color-mix(in_oklch,var(--surface-success-strong)_16%,transparent)] text-[var(--surface-success-strong)]",
    dot: "bg-[var(--surface-success-strong)]",
  },
  {
    value: "deny",
    label: "Deny",
    active:
      "bg-[color-mix(in_oklch,var(--surface-critical-strong)_16%,transparent)] text-[var(--surface-critical-strong)]",
    dot: "bg-[var(--surface-critical-strong)]",
  },
  {
    value: "ask",
    label: "Ask",
    active:
      "bg-[color-mix(in_oklch,var(--surface-warning-strong)_16%,transparent)] text-[var(--surface-warning-strong)]",
    dot: "bg-[var(--surface-warning-strong)]",
  },
];

/** Draft rows carry a stable client key so reordering never remounts inputs. */
interface RuleDraft extends PermissionRule {
  key: number;
}

function rulesEqual(a: PermissionRuleset, b: PermissionRuleset): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function PermissionRulesEditor(props: PermissionRulesEditorProps) {
  const { rules, onSave, onCancel } = props;

  const actionsListID = useId();

  const [rows, setRows] = useState<RuleDraft[]>(() =>
    rules.map((rule, i) => ({
      key: i,
      action: rule.action,
      resource: rule.resource,
      effect: rule.effect,
    })),
  );
  const nextKey = useRef(rules.length);

  const draft: PermissionRuleset = rows.map(({ action, resource, effect }) => ({
    action,
    resource,
    effect,
  }));

  const dirty = !rulesEqual(draft, rules);
  const invalid = rows.some(
    (row) => row.action.trim() === "" || row.resource.trim() === "",
  );
  const canSave = dirty && !invalid;

  const addRow = () => {
    const key = nextKey.current++;
    setRows((prev) => [...prev, { key, action: "", resource: "", effect: "ask" }]);
  };

  const updateRow = (index: number, patch: Partial<PermissionRule>) => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const moveRow = (index: number, delta: number) => {
    setRows((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const a = next[index]!;
      next[index] = next[target]!;
      next[target] = a;
      return next;
    });
  };

  return (
    <section
      data-oc-permission-rules-editor
      aria-label="Permission rules"
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-3"
    >
      <header className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-[var(--text-weak)]" />
        <h3 className="text-sm font-medium text-[var(--text-strong)]">
          Permission rules
        </h3>
        <span className="text-[11px] text-[var(--text-weaker)]">
          {rows.length} rule{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      <p className="text-[11px] leading-relaxed text-[var(--text-weaker)]">
        Rules are evaluated <span className="text-[var(--text-weak)]">top to bottom</span>{" "}
        and the{" "}
        <span className="font-medium text-[var(--text-weak)]">
          last matching rule wins
        </span>
        . Session rules run after the agent&apos;s rules. Saving replaces the whole
        ruleset (it is not a merge).
      </p>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border-weak-base)] px-3 py-4 text-center text-xs text-[var(--text-weaker)]">
          No session rules — the agent&apos;s own rules apply.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((row, index) => {
            const emptyAction = row.action.trim() === "";
            const emptyResource = row.resource.trim() === "";
            return (
              <li
                key={row.key}
                data-oc-permission-rule-row={index}
                className="flex flex-wrap items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2 py-1.5"
              >
                <span
                  className="w-5 shrink-0 text-right text-[11px] tabular-nums text-[var(--text-weaker)]"
                  title="Evaluation order"
                >
                  {index + 1}
                </span>

                <Input
                  value={row.action}
                  list={actionsListID}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Rule ${index + 1} action`}
                  aria-invalid={emptyAction}
                  placeholder="read | edit | *"
                  onChange={(e) => updateRow(index, { action: e.target.value })}
                  className={cn(
                    "h-7 w-[9.5rem] shrink-0 font-mono text-[12px]",
                    emptyAction && "border-[var(--surface-critical-strong)]",
                  )}
                />

                <Input
                  value={row.resource}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Rule ${index + 1} resource`}
                  aria-invalid={emptyResource}
                  placeholder="path/glob or *"
                  onChange={(e) => updateRow(index, { resource: e.target.value })}
                  className={cn(
                    "h-7 min-w-[8rem] flex-1 font-mono text-[12px]",
                    emptyResource && "border-[var(--surface-critical-strong)]",
                  )}
                />

                <div
                  className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5"
                  role="group"
                  aria-label={`Rule ${index + 1} effect`}
                >
                  {EFFECTS.map((effect) => {
                    const selected = row.effect === effect.value;
                    return (
                      <button
                        key={effect.value}
                        type="button"
                        data-oc-permission-rule-effect={effect.value}
                        aria-pressed={selected}
                        onClick={() => updateRow(index, { effect: effect.value })}
                        className={cn(
                          "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                          selected
                            ? effect.active
                            : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            selected ? effect.dot : "bg-[var(--text-weaker)]",
                          )}
                        />
                        {effect.label}
                      </button>
                    );
                  })}
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    className="size-7 p-0"
                    title="Move up (evaluated earlier)"
                    disabled={index === 0}
                    onClick={() => moveRow(index, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="size-7 p-0"
                    title="Move down (evaluated later — wins over earlier matches)"
                    disabled={index === rows.length - 1}
                    onClick={() => moveRow(index, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="size-7 p-0 text-[var(--text-weak)] hover:text-[color:var(--surface-critical-strong)]"
                    title="Remove rule"
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <datalist id={actionsListID}>
        {KNOWN_ACTIONS.map((action) => (
          <option key={action} value={action} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={addRow}>
          <Plus className="size-3.5" />
          Add rule
        </Button>
        <span className="text-[11px] text-[var(--text-weaker)]">
          {invalid
            ? "Every rule needs an action and a resource."
            : dirty
              ? "Unsaved changes."
              : "No changes."}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" className="h-7 px-2.5 text-[11px]" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="h-7 px-2.5 text-[11px]"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "permission.rulesEditor": (p) => (
    <PermissionRulesEditor {...(p as unknown as PermissionRulesEditorProps)} />
  ),
});
