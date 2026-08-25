import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { CircleHelpIcon, ClipboardListIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import type { FormField, QuestionAnswer } from "../api/types";
import {
  cancelPendingRequest,
  getState,
  loadSessionDetail,
  pendingRequests,
  replyForm,
  replyPermission,
  replyQuestion,
  selectSession,
  sessionLabel,
  useStore,
  type PendingRequest,
  type QueuedForm,
  type QueuedPermission,
  type QueuedQuestion,
} from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";

/**
 * The ONE popup for everything the agent needs a human decision on:
 * permissions, questions, forms — across ALL sessions, in arrival order
 * (FIFO by insertion into the store). Never filtered by the open session:
 * a request that arrives while you are elsewhere still pops up here,
 * labelled with its session and an amber "another session" notice, so it
 * can never sit unnoticed. Esc / overlay-click / ✕ cancel the head request
 * (permission & question → reject, form → cancel); answering reveals the
 * next one automatically.
 */

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const foreignRowCls =
  "border-l-[color:var(--surface-warning-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-warning-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-warning-strong)_8%,transparent)]";

const insetBox =
  "overflow-x-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-base)]";

export function PendingRequestsModal() {
  const queue = useStore(pendingRequests);
  const head = queue[0];
  if (!head) return null;
  return <RequestDialog key={`${head.kind}:${head.req.id}`} item={head} behind={queue.slice(1)} />;
}

const KIND_META = {
  permission: { icon: ShieldAlertIcon, label: "Permission required", cancelHint: "esc rejects" },
  question: { icon: CircleHelpIcon, label: "Question", cancelHint: "esc rejects" },
  form: { icon: ClipboardListIcon, label: "Form", cancelHint: "esc cancels" },
} as const;

function RequestDialog({ item, behind }: { item: PendingRequest; behind: PendingRequest[] }) {
  const [open, setOpen] = useState(true);
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;
  const sessionID = item.req.sessionID;
  const label = useStore((s) => sessionLabel(s, sessionID));
  const foreign = useStore((s) => s.currentSessionID !== sessionID);
  const foreignBehind = useStore((s) => behind.filter((r) => r.req.sessionID !== s.currentSessionID).length);
  const contentRef = useRef<HTMLDivElement>(null);

  // Subagent (and other unlisted) sessions may not be in any cached list yet;
  // fetch the detail once so the badge shows a real title instead of an id.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (attempted.current.has(sessionID)) return;
    attempted.current.add(sessionID);
    const s = getState();
    if (!s.sessions.some((x) => x.id === sessionID) && !s.sessionDetails[sessionID]) {
      void loadSessionDetail(sessionID);
    }
  }, [sessionID]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) cancelPendingRequest(item);
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content
          ref={contentRef}
          tabIndex={-1}
          data-slot="dialog-content"
          className={contentCls}
          // Focus the box itself, not the first button — a stray Enter must
          // never fire "Reject".
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 shrink-0 text-[var(--text-interactive-base)]" aria-hidden />
              {item.kind === "form" ? item.req.title || "Form" : meta.label}
              <Badge variant="outline" className="max-w-56 truncate border-[var(--border-weak-base)] font-normal text-[var(--text-weak)]">
                {label}
              </Badge>
              {foreign && (
                <Badge variant="outline" className="border-[color-mix(in_oklch,var(--surface-warning-strong)_40%,transparent)] text-[var(--surface-warning-strong)]">
                  another session
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          {foreign && (
            <div className={`flex items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-xs ${foreignRowCls}`}>
              <span className="min-w-0 flex-1 text-[var(--text-base)]">
                Asked by <span className="font-medium">{label}</span> while you're in another session — answer right here, or jump over.
              </span>
              <Button variant="outline" size="xs" onClick={() => void selectSession(sessionID)}>
                Switch
              </Button>
            </div>
          )}

          {item.kind === "permission" && <PermissionBody req={item.req} />}
          {item.kind === "question" && <QuestionBody req={item.req} />}
          {item.kind === "form" && <FormBody req={item.req} />}

          <p className="text-xs text-[var(--text-weaker)]">
            {behind.length > 0 && (
              <>
                {behind.length} more queued after this
                {foreignBehind > 0 ? ` (${foreignBehind} from other sessions)` : ""}.{" "}
              </>
            )}
            <span className="whitespace-nowrap">
              <kbd className="rounded border border-[var(--border-weak-base)] px-1 font-sans">esc</kbd> {meta.cancelHint}
            </span>
          </p>

          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
              <XIcon />
              <span className="sr-only">Cancel</span>
            </Button>
          </DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

// ---- kind bodies ---------------------------------------------------------

function PermissionBody({ req }: { req: QueuedPermission }) {
  return (
    <>
      {req.resources.length > 0 && (
        <div className="space-y-1">
          {req.resources.map((r, i) => (
            <pre key={i} className={insetBox}>
              {r}
            </pre>
          ))}
        </div>
      )}
      {req.metadata && Object.keys(req.metadata).length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2.5 font-mono text-xs whitespace-pre-wrap text-[var(--text-weak)]">
          {JSON.stringify(req.metadata, null, 2)}
        </pre>
      )}
      {req.source && (
        <DialogDescription>
          Requested by tool <span className="font-mono text-[var(--text-strong)]">{req.source.id}</span>
        </DialogDescription>
      )}
      <DialogFooter className="rounded-b-lg">
        <Button variant="destructive" onClick={() => void replyPermission(req.id, "reject")}>
          Reject
        </Button>
        <Button variant="secondary" onClick={() => void replyPermission(req.id, "once")}>
          Once
        </Button>
        <Button onClick={() => void replyPermission(req.id, "always")}>Always allow</Button>
      </DialogFooter>
    </>
  );
}

function QuestionBody({ req }: { req: QueuedQuestion }) {
  const [selected, setSelected] = useState<QuestionAnswer[]>(() => req.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""));

  const toggle = (qi: number, label: string) => {
    const multiple = req.questions[qi]?.multiple;
    setSelected((prev) => {
      const next = prev.map((a, i) => (i === qi ? [...a] : a));
      const cur = next[qi]!;
      next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : multiple ? [...cur, label] : [label];
      return next;
    });
  };

  const buildAnswers = (): QuestionAnswer[] =>
    req.questions.map((q, i) => {
      const answers = [...selected[i]!];
      if (q.custom && custom[i]!.trim()) answers.push(custom[i]!.trim());
      return answers;
    });

  const complete = req.questions.every(
    (q, i) => selected[i]!.length > 0 || (q.custom && custom[i]!.trim().length > 0),
  );

  return (
    <>
      {req.tool && (
        <DialogDescription>
          Asked by tool <span className="font-mono text-[var(--text-strong)]">{req.tool.id}</span>
        </DialogDescription>
      )}
      <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
        {req.questions.map((q, qi) => (
          <div key={qi} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-[var(--text-weak)]">{q.header}</span>
              {q.multiple && (
                <Badge variant="outline" className="border-[var(--border-weak-base)] text-[var(--text-weak)]">
                  multiple
                </Badge>
              )}
            </div>
            <p className="text-sm text-[var(--text-strong)]">{q.question}</p>
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const active = selected[qi]!.includes(opt.label);
                  return (
                    <Button
                      key={opt.label}
                      type="button"
                      variant={active ? "default" : "secondary"}
                      size="sm"
                      title={opt.description}
                      onClick={() => toggle(qi, opt.label)}
                    >
                      {opt.label}
                    </Button>
                  );
                })}
              </div>
            )}
            {q.custom && (
              <Textarea
                value={custom[qi]}
                onChange={(e) => setCustom((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                placeholder="Custom answer"
                className="min-h-16 font-mono text-xs"
              />
            )}
          </div>
        ))}
      </div>
      <DialogFooter className="rounded-b-lg">
        <Button variant="destructive" onClick={() => void cancelPendingRequest({ kind: "question", req })}>
          Reject
        </Button>
        <Button disabled={!complete} onClick={() => void replyQuestion(req.id, buildAnswers())}>
          Reply
        </Button>
      </DialogFooter>
    </>
  );
}

function FormBody({ req }: { req: QueuedForm }) {
  const fields = req.fields;
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
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || busy) return;
        setBusy(true);
        void replyForm(req.id, values).finally(() => setBusy(false));
      }}
    >
      {fields.map((f) => (
        <Field key={f.key} field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
      ))}
      <DialogFooter className="rounded-b-lg">
        <Button type="button" variant="ghost" onClick={() => cancelPendingRequest({ kind: "form", req })}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || busy}>
          Submit
        </Button>
      </DialogFooter>
    </form>
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
  const inputCls =
    "w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--input-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)] focus:ring-1 focus:ring-[var(--border-selected)]";

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
                      onChange(e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value));
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
