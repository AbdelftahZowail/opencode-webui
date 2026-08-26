import { useEffect, useRef, useState } from "react";
import { CircleHelpIcon, ClipboardListIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import type { FormField, QuestionAnswer } from "../api/types";
import {
  cancelPendingRequest,
  pendingRequests,
  replyForm,
  replyPermission,
  replyQuestion,
  sessionLabel,
  useStore,
  type PendingRequest,
  type QueuedForm,
  type QueuedPermission,
  type QueuedQuestion,
} from "../store";
import { log } from "../lib/log";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

/**
 * The agent-needs-you panel, docked in the composer slot (RunsPanel idiom,
 * NOT a floating dialog): when THIS session has an unanswered permission /
 * question / form, it replaces the composer until resolved. Per session —
 * requests from OTHER sessions surface through the corner chip instead
 * (App). Esc rejects/cancels the head request (capture-phase key owner, so
 * the site-wide interrupt arming never sees the key); answering reveals the
 * next one automatically. The panel never dismisses on outside clicks — a
 * blocked agent must stay visible.
 *
 * Questions render as a wizard: multi-question popups show ONE question at
 * a time under a title stepper (answered steps reviewable via Back/chips);
 * tapping a single-choice option auto-advances and auto-submits on the last
 * step; multiselect/text steps advance explicitly. ctrl/cmd+Enter = next /
 * submit.
 */

const ACCENT: Record<PendingRequest["kind"], string> = {
  permission: "var(--surface-critical-strong)",
  question: "var(--text-interactive-base)",
  form: "var(--surface-warning-strong)",
};

const KIND_META = {
  permission: { icon: ShieldAlertIcon, label: "Permission required", hint: "esc rejects" },
  question: { icon: CircleHelpIcon, label: "Question", hint: "esc rejects" },
  form: { icon: ClipboardListIcon, label: "Form", hint: "esc cancels" },
} as const;

const insetBox =
  "overflow-x-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-base)]";

export function PendingRequestsPanel({ sessionID }: { sessionID: string }) {
  const head = useStore((s) => pendingRequests(s).find((r) => r.req.sessionID === sessionID));
  const behind = useStore(
    (s) => pendingRequests(s).filter((r) => r.req.sessionID === sessionID).length - 1,
  );
  if (!head) return null;
  return <RequestPanel key={`${head.kind}:${head.req.id}`} item={head} behind={behind} />;
}

function RequestPanel({ item, behind }: { item: PendingRequest; behind: number }) {
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;
  const accent = ACCENT[item.kind];
  const boxRef = useRef<HTMLDivElement>(null);
  const label = useStore((s) => sessionLabel(s, item.req.sessionID));

  // Capture-phase Esc owner (same idiom as RunsPanel): reject/cancel the
  // head request and swallow the key so the site-wide interrupt arming and
  // any other global binding stay idle. A dialog stacked ABOVE the panel
  // (settings, help…) gets Esc first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      cancelPendingRequest(item);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [item]);

  // Park focus on the box (not a button) so a stray Enter can't confirm
  // anything; Tab reaches the controls from there. Keyed on the REQUEST
  // identity — the item prop gets fresh object identities on every queue
  // refresh, and re-focusing per refresh used to yank focus out of the
  // custom-answer textarea every ~10s.
  const requestKey = `${item.kind}:${item.req.id}`;
  useEffect(() => {
    log("panel", `show ${requestKey}`);
    const raf = requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      log("panel", `hide ${requestKey}`);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-2 pt-2">
      <div className="mx-auto max-w-3xl">
        <div
          ref={boxRef}
          tabIndex={-1}
          className="max-h-72 overflow-y-auto border-l-2 bg-[color:var(--background-strong)] px-4 py-2 font-mono text-sm outline-none"
          style={{ borderLeftColor: accent }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`flex shrink-0 items-center gap-1.5 font-medium ${
                  item.kind === "permission"
                    ? "text-[color:var(--surface-critical-strong)]"
                    : item.kind === "question"
                      ? "text-[color:var(--text-interactive-base)]"
                      : "text-[color:var(--surface-warning-strong)]"
                }`}
              >
                <Icon className="size-3.5" aria-hidden />
                {item.kind === "form" ? item.req.title || "Form" : meta.label}
              </span>
              <Badge variant="outline" className="max-w-52 truncate border-[var(--border-weak-base)] font-normal text-[var(--text-weak)]">
                {label}
              </Badge>
            </div>
            <button
              type="button"
              onClick={() => cancelPendingRequest(item)}
              title={meta.hint}
              className="flex shrink-0 cursor-pointer items-center gap-1 font-mono text-xs text-[color:var(--text-weaker)] hover:text-[color:var(--text-weak)]"
            >
              {meta.hint.replace("esc ", "")}
              <XIcon className="size-3.5" />
            </button>
          </div>

          <div className="pt-1.5">
            {item.kind === "permission" && <PermissionBody req={item.req} />}
            {item.kind === "question" && <QuestionBody req={item.req} />}
            {item.kind === "form" && <FormBody req={item.req} />}
          </div>

          {behind > 0 && (
            <p className="pt-1.5 text-xs text-[color:var(--text-weaker)]">
              +{behind} more queued in this session
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- bodies --------------------------------------------------------------

function PermissionBody({ req }: { req: QueuedPermission }) {
  return (
    <>
      {req.resources.length > 0 && (
        <div className="space-y-1 pb-1.5">
          {req.resources.map((r, i) => (
            <pre key={i} className={insetBox}>
              {r}
            </pre>
          ))}
        </div>
      )}
      {req.metadata && Object.keys(req.metadata).length > 0 && (
        <pre className="max-h-40 overflow-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2.5 mb-1.5 font-mono text-xs whitespace-pre-wrap text-[var(--text-weak)]">
          {JSON.stringify(req.metadata, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-sans text-xs text-[color:var(--text-weak)]">
          {req.source ? <>by tool <span className="font-mono">{req.source.id}</span></> : req.action || null}
        </span>
        <div className="flex gap-1.5">
          <Button variant="destructive" size="sm" onClick={() => void replyPermission(req.id, "reject")}>
            Reject
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void replyPermission(req.id, "once")}>
            Once
          </Button>
          <Button size="sm" onClick={() => void replyPermission(req.id, "always")}>
            Always allow
          </Button>
        </div>
      </div>
    </>
  );
}

function QuestionBody({ req }: { req: QueuedQuestion }) {
  const total = req.questions.length;
  const [selected, setSelected] = useState<QuestionAnswer[]>(() => req.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""));
  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);
  const [failed, setFailed] = useState(false);

  const valueOf = (o: { label: string; value?: string }) => o.value ?? o.label;
  const q = req.questions[Math.min(step, total - 1)]!;
  const isLast = step >= total - 1;

  const stepComplete = (i: number) => {
    const qq = req.questions[i]!;
    return selected[i]!.length > 0 || (qq.custom && custom[i]!.trim().length > 0);
  };

  /** Full wire payload; `override` carries a JUST-tapped pick synchronously
   * (state hasn't flushed yet) and beats typed custom text — an explicit tap
   * is the user's final word for that step. */
  const compose = (override?: { qi: number; picked: string[]; explicit?: boolean }): QuestionAnswer[] =>
    req.questions.map((qq, i) => {
      const picked = override && override.qi === i ? override.picked : selected[i]!;
      const text = custom[i]!.trim();
      if (!qq.multiple) {
        if (override?.explicit && override.qi === i) return picked.slice(0, 1);
        // One string per single-select question; typed custom text replaces
        // a picked option (both cannot travel in one string).
        return text ? [text] : picked.slice(0, 1);
      }
      // Multi-select: every chosen option value plus any custom text —
      // the engine stores them all in the answer array.
      return [...picked, ...(text ? [text] : [])];
    });

  const doSubmit = (payload: QuestionAnswer[]) => {
    setFailed(false);
    void replyQuestion(req.id, payload).then((ok) => {
      if (!ok) setFailed(true);
    });
  };

  /** Advance to step `next`; falling off the end submits the whole form. */
  const advance = (next: number, override?: { qi: number; picked: string[]; explicit?: boolean }) => {
    if (next >= total) doSubmit(compose(override));
    else {
      setFailed(false);
      setStep(next);
      setMaxReached((m) => Math.max(m, next));
    }
  };

  const onOption = (qi: number, qq: QueuedQuestion["questions"][number], value: string) => {
    setFailed(false);
    if (qq.multiple) {
      // Multi-select: taps accumulate — advancing is explicit (Next/ctrl+⏎).
      setSelected((prev) =>
        prev.map((a, i) =>
          i === qi ? (a.includes(value) ? a.filter((v) => v !== value) : [...a, value]) : a,
        ),
      );
      return;
    }
    // Single-select: the engine accepts exactly ONE string — picking another
    // option replaces it. A tap IS the answer: auto-advance (or auto-submit
    // on the last step) without needing Reply, like the TUI's option keys.
    const nextPicked = selected[qi]!.includes(value) ? [] : [value];
    setSelected((prev) => prev.map((a, i) => (i === qi ? nextPicked : a)));
    advance(qi + 1, { qi, picked: nextPicked, explicit: true });
  };

  // ctrl/cmd+Enter: next unanswered step, or submit on the last one.
  const advanceRef = useRef<() => void>(() => {});
  advanceRef.current = () => {
    if (isLast) {
      if (req.questions.every((_, i) => stepComplete(i))) doSubmit(compose());
      else setFailed(false);
    } else if (stepComplete(step)) advance(step + 1);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      advanceRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      {/* Stepper: question titles across the top (multi-question popups only).
          Done steps are reviewable; future steps unlock by answering. */}
      {total > 1 && (
        <div className="flex flex-wrap items-center gap-1 pb-1.5">
          {req.questions.map((qq, i) => (
            <button
              key={i}
              type="button"
              disabled={i > maxReached}
              onClick={() => i <= maxReached && (setStep(i), setFailed(false))}
              title={qq.question || qq.header}
              className={`max-w-40 cursor-pointer truncate rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${
                i === step
                  ? "bg-[color:var(--surface-inset-strong,var(--surface-inset-base))] text-[color:var(--text-strong)] outline outline-1 outline-[var(--border-selected,var(--border-weak-base))]"
                  : i < maxReached || (i === maxReached && i !== step)
                    ? "text-[color:var(--text-weak)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-strong)]"
                    : "cursor-default text-[color:var(--text-weaker)] opacity-60"
              }`}
            >
              {stepComplete(i) && i !== step ? "✓ " : ""}
              {qq.header || `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {req.tool && (
        <p className="pb-1.5 font-sans text-xs text-[color:var(--text-weak)]">
          by tool <span className="font-mono">{req.tool.id}</span>
        </p>
      )}
      <div>
        <div className="flex items-baseline gap-2">
          {q.header && total > 1 && (
            <span className="shrink-0 text-xs text-[color:var(--text-weaker)]">
              {step + 1}/{total}
            </span>
          )}
          <span className="min-w-0 break-words text-sm text-[color:var(--text-strong)]">{q.question}</span>
        </div>
        {q.options.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {q.options.map((opt) => {
              const v = valueOf(opt);
              const active = selected[step]!.includes(v);
              return (
                <Button
                  key={v}
                  type="button"
                  variant={active ? "default" : "secondary"}
                  size="xs"
                  title={opt.description}
                  onClick={() => onOption(step, q, v)}
                >
                  {opt.label}
                </Button>
              );
            })}
          </div>
        )}
        {q.custom && (
          <Textarea
            value={custom[step]}
            onChange={(e) => {
              setFailed(false);
              setCustom((prev) => prev.map((v, i) => (i === step ? e.target.value : v)));
            }}
            placeholder="Custom answer…"
            className="mt-1 min-h-12 font-mono text-xs"
          />
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-1.5">
        {failed && (
          <p className="mr-auto font-sans text-xs text-[color:var(--surface-critical-strong)]">
            answer rejected — request still open, adjust and retry
          </p>
        )}
        {total > 1 && step > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={() => void cancelPendingRequest(itemToCancel())}>
          Reject
        </Button>
        {!isLast ? (
          <Button size="sm" disabled={!stepComplete(step)} onClick={() => advance(step + 1)}>
            Next
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!req.questions.every((_, i) => stepComplete(i))}
            onClick={() => doSubmit(compose())}
          >
            Reply
          </Button>
        )}
      </div>
    </>
  );

  function itemToCancel(): PendingRequest {
    return { kind: "question", req };
  }
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
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || busy) return;
        setBusy(true);
        void replyForm(req.id, values).finally(() => setBusy(false));
      }}
    >
      {fields.map((f) => (
        <div key={f.key} className="pb-1.5">
          <Field field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} />
        </div>
      ))}
      <div className="flex justify-end gap-1.5 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => cancelPendingRequest({ kind: "form", req })}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit || busy}>
          Submit
        </Button>
      </div>
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
    "w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--input-base)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)] focus:ring-1 focus:ring-[var(--border-selected)]";

  const label = (
    <label className="mb-1 block font-sans text-xs font-medium text-[var(--text-base)]">
      {field.title ?? field.key}
      {field.type !== "external" && field.required && <span className="text-[var(--surface-critical-strong)]"> *</span>}
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
        <label className="flex cursor-pointer items-center gap-2 font-sans text-sm text-[var(--text-base)]">
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
                <label key={o.value} className="flex cursor-pointer items-center gap-2 font-sans text-sm text-[var(--text-base)]">
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
        <div className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-3 py-2 font-sans text-xs text-[var(--text-base)]">
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
