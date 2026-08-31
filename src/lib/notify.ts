export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
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

export function notify(opts: { title: string; description?: string; variant?: "default" | "destructive" }): string {
  const id = `toast_${Date.now().toString(36)}_${++seq}`;
  const toast: Toast = {
    id,
    title: opts.title,
    description: opts.description,
    variant: opts.variant ?? "default",
    created: Date.now(),
  };
  toasts = [...toasts, toast];
  emit();
  setTimeout(() => dismissToast(id), 3000);
  return id;
}
