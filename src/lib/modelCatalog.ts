/**
 * Shared, prefetched model catalog. One module-level cache is used by every
 * model picker AND by the default-model resolver (`lib/modelMemory`), so the
 * first open is warm and remembered-model validation is possible without a
 * fresh round-trip.
 *
 * Shape: one in-flight promise, a tiny subscribe list, and a status the UI can
 * render ("Loading models…" / error). Deliberately NO store import — the store
 * imports `lib/modelMemory`, which imports this; a store import here would
 * cycle. Boot prefetch happens the moment this module is first imported (it is
 * pulled in by the pickers and — once wired — the store).
 */

import { api } from "../api/client";
import type { ModelInfo } from "../api/types";

export type CatalogStatus = "idle" | "loading" | "ready" | "error";

let models: ModelInfo[] = [];
let status: CatalogStatus = "idle";
let inflight: Promise<ModelInfo[]> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeCatalog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getModels(): ModelInfo[] {
  return models;
}

export function getCatalogStatus(): CatalogStatus {
  return status;
}

export function getEnabledModels(): ModelInfo[] {
  return models.filter((m) => m.enabled);
}

/**
 * Ensure the catalog is loaded; every concurrent caller shares one request.
 * A previous failure is retried on the next call (status flips back to
 * "loading") so a transient proxy hiccup is not permanent.
 */
export function ensureModels(): Promise<ModelInfo[]> {
  if (status === "ready") return Promise.resolve(models);
  if (inflight) return inflight;
  status = "loading";
  emit();
  inflight = api
    .models()
    .then((list) => {
      models = list;
      status = "ready";
      return models;
    })
    .catch(() => {
      status = "error";
      return models;
    })
    .finally(() => {
      inflight = null;
      emit();
    });
  return inflight;
}

// Prefetch at boot — importing this module is enough. Guarded so a non-browser
// import (tests, tooling) never touches the network.
if (typeof window !== "undefined") {
  void ensureModels();
}
