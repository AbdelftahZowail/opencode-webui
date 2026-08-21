import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import type { FormField } from "../api/types";
import { cancelForm, replyForm, useStore } from "../store";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const inputCls =
  "w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--input-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)] focus:ring-1 focus:ring-[var(--border-selected)]";

export function FormModal() {
  const currentID = useStore((s) => s.currentSessionID);
  const forms = useStore((s) => s.forms);
  const mine = forms.filter((f) => f.sessionID === currentID);

  if (mine.length === 0) return null;
  const form = mine[0]!;
  return <FormView key={form.id} formID={form.id} title={form.title} fields={form.fields} />;
}

function FormView({
  formID,
  title,
  fields,
}: {
  formID: string;
  title: string;
  fields: FormField[];
}) {
  const [open, setOpen] = useState(true);
  const [values, setValues] = useState<Record<string, string | number | boolean | string[]>>(() => {
    const init: Record<string, string | number | boolean | string[]> = {};
    for (const f of fields) {
      if (f.type === "external") continue;
      if (f.default !== undefined) init[f.key] = f.default as never;
      else if (f.type === "multiselect") init[f.key] = [];
      else if (f.type === "boolean") init[f.key] = false;
      else init[f.key] = "";
    }
    return init;
  });
  const [busy, setBusy] = useState(false);

  const required = fields.filter((f): f is Exclude<FormField, { type: "external" }> => f.type !== "external" && f.required === true);
  const canSubmit = required.every((f) => {
    const v = values[f.key];
    if (f.type === "boolean") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "number") return true;
    return typeof v === "string" && v.trim().length > 0;
  });

  function set<K extends string>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) void cancelForm(formID);
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader>
            <DialogTitle>{title || "Form"}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit || busy) return;
              setBusy(true);
              void replyForm(formID, values).finally(() => setBusy(false));
            }}
          >
            {fields.map((f) => (
              <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
            ))}
            <DialogFooter className="rounded-b-lg">
              <Button type="button" variant="ghost" onClick={() => void cancelForm(formID)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit || busy}>
                Submit
              </Button>
            </DialogFooter>
          </form>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | number | boolean | string[] | undefined;
  onChange: (v: string | number | boolean | string[]) => void;
}) {
  const label = (
    <label className="mb-1 block text-xs font-medium text-[var(--text-base)]">
      {field.title ?? field.key}
      {field.type !== "external" && field.required && <span className="text-[var(--surface-critical-strong)]"> *</span>}
      {field.description && <span className="ml-2 font-normal text-[var(--text-weaker)]">{field.description}</span>}
    </label>
  );

  switch (field.type) {
    case "string":
      return (
        <div>
          {label}
          {field.options && field.options.length > 0 ? (
            <select className={inputCls} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}>
              <option value="">—</option>
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputCls}
              placeholder={field.placeholder}
              value={(value as string) ?? ""}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      );
    case "number":
    case "integer":
      return (
        <div>
          {label}
          <input
            type="number"
            className={inputCls}
            value={(value as number) ?? ""}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </div>
      );
    case "boolean":
      return (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-base)]">
          <input
            type="checkbox"
            className="accent-[var(--text-interactive-base)]"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.title ?? field.key}
        </label>
      );
    case "multiselect":
      return (
        <div>
          {label}
          <div className="space-y-1">
            {field.options.map((o) => {
              const selected = ((value as string[]) ?? []).includes(o.value);
              return (
                <label key={o.value} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text-base)]">
                  <input
                    type="checkbox"
                    className="accent-[var(--text-interactive-base)]"
                    checked={selected}
                    onChange={(e) => {
                      const current = (value as string[]) ?? [];
                      onChange(
                        e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value),
                      );
                    }}
                  />
                  {o.label}
                </label>
              );
            })}
          </div>
        </div>
      );
    case "external":
      return (
        <div className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-3 py-2 text-xs text-[var(--text-base)]">
          {field.title ?? "External input"}:{" "}
          <a className="text-[var(--text-interactive-base)] underline" href={field.url} target="_blank" rel="noreferrer">
            {field.url}
          </a>
        </div>
      );
    default:
      return null;
  }
}
