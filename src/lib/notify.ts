export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
  /** Optional inline action button (R5): label + handler, run on click. */
  action?: { label: string; onClick: () => void };
  created: number;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const fn of listeners) fn();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

export function dismissToast(id: string) {
  const before = toasts.length;
  toasts = toasts.filter((t) => t.id !== id);
  if (toasts.length !== before) emit();
}

export function notify(opts: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
  action?: { label: string; onClick: () => void };
}): string {
  const id = `toast_${Date.now().toString(36)}_${++seq}`;
  const toast: Toast = {
    id,
    title: opts.title,
    description: opts.description,
    variant: opts.variant ?? "default",
    action: opts.action,
    created: Date.now(),
  };
  toasts = [...toasts, toast];
  emit();
  // A toast carrying an action waits for the user (an actionable prompt that
  // vanishes in 3s is useless); a plain toast auto-dismisses as before.
  if (!toast.action) setTimeout(() => dismissToast(id), 3000);
  return id;
}
