import type { ReactNode } from "react";
import { Badge as BadgePrimitive } from "./ui/badge";
import { Button as ButtonPrimitive } from "./ui/button";
import { cn } from "@/lib/utils";

const buttonVariantMap = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  outline: "outline",
  danger: "destructive",
} as const;

export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  className = "",
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  disabled?: boolean;
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <ButtonPrimitive
      type={type}
      title={title}
      variant={buttonVariantMap[variant]}
      className={className}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </ButtonPrimitive>
  );
}

export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-[color-mix(in_oklch,var(--border-selected)_30%,transparent)] border-t-[var(--border-selected)] ${className}`}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={`w-full ${width} rounded-xl border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-weak-base)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--text-strong)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-[var(--text-weak)] transition-colors hover:text-[var(--text-strong)]"
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

const badgeTones = {
  neutral: "bg-[var(--surface-raised-base)] text-[var(--text-weak)]",
  green: "bg-[color-mix(in_oklch,var(--surface-success-strong)_12%,transparent)] text-[var(--surface-success-strong)]",
  red: "bg-[color-mix(in_oklch,var(--surface-critical-strong)_12%,transparent)] text-[var(--surface-critical-strong)]",
  blue: "bg-[color-mix(in_oklch,var(--border-selected)_12%,transparent)] text-[var(--text-interactive-base)]",
  amber: "bg-[color-mix(in_oklch,var(--surface-warning-strong)_12%,transparent)] text-[var(--surface-warning-strong)]",
} as const;

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "red" | "blue" | "amber";
}) {
  return (
    <BadgePrimitive variant="secondary" className={cn(badgeTones[tone])}>
      {children}
    </BadgePrimitive>
  );
}

export function timeAgo(ts: number): string {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
