/**
 * The ONE extension API surface (spec §10, step §11.6).
 *
 * Replaces the narrow `window.__opencodeUI` bridge (`register` + `react` +
 * `notify` + `getHooks` only). External (user/project-dir) bundles and our
 * shipped extensions use this identically: shipped code imports
 * `getExtensionApi()` directly (same build, zero indirection), external
 * bundles read the same object off `window.__opencodeUI` (installed once at
 * boot by `main.tsx`, re-ensured by the runtime loader).
 *
 * Surface keys are the contract — adding/removing one is a version bump
 * (`EXT_API_VERSION`) with a migration note, never a silent break:
 *
 *   register — the five registry kinds (wrap/replace/contribute/hook/service)
 *   react    — the app's React namespace (shared copy — the proxy resolves
 *              `react` to the app's node_modules when bundling, so external
 *              bundles render with the same instance)
 *   api      — the typed engine client (one function per endpoint)
 *   store    — full app access: `useStore`, `getState`, and every action
 *   prefs    — user prefs (`getPrefs`/`setPref`/`subscribePrefs`)
 *   notify   — bottom-right toasts (3s)
 *   services — named logic (`getService`/`getServiceProviders`; doubles as
 *              value overrides — the highest-precedence provider wins)
 *   dom      — the DOM-stratum kit surface: mount/dispose plumbing plus the
 *              versioned `data-oc-*` anchor table (`dom.ts` modules receive
 *              their kit directly in `mount(kit)` — this is for imperative
 *              use from browser-stratum code)
 *   kv       — per-extension persistent browser store (`kv.forExt(id)`)
 *
 * Server-stratum routes (`/api/webui/ext/<id>/…`) need no helper: same-origin
 * `fetch` from the page carries the session cookie, so plain `fetch` IS the
 * one method (documented, not wrapped).
 */

import * as React from "react";
import { register, getService, getServiceProviders } from "../extensions/registry";
import { api } from "../api/client";
import * as store from "../store";
import { getPrefs, setPref, subscribePrefs } from "../prefs";
import { notify } from "./notify";
import {
  mountDomExtension,
  disposeDomExtension,
  isDomExtensionModule,
  OC_ANCHORS,
  DOM_STRATUM_VERSION,
} from "./domKit";
import { extKv } from "./extKv";

/** Extension API contract version. Bump on any key/shape change + note. */
export const EXT_API_VERSION = 1;

export interface ExtensionApi {
  version: number;
  register: typeof register;
  react: typeof React;
  api: typeof api;
  store: typeof store;
  prefs: {
    getPrefs: typeof getPrefs;
    setPref: typeof setPref;
    subscribePrefs: typeof subscribePrefs;
  };
  notify: typeof notify;
  services: {
    getService: typeof getService;
    getServiceProviders: typeof getServiceProviders;
  };
  dom: {
    mount: typeof mountDomExtension;
    dispose: typeof disposeDomExtension;
    isModule: typeof isDomExtensionModule;
    anchors: typeof OC_ANCHORS;
    version: typeof DOM_STRATUM_VERSION;
  };
  kv: {
    forExt: typeof extKv;
  };
}

declare global {
  interface Window {
    __opencodeUI: ExtensionApi;
  }
}

/** Build a fresh surface object (refs are module singletons — all stable). */
export function createExtensionApi(): ExtensionApi {
  return {
    version: EXT_API_VERSION,
    register,
    react: React,
    api,
    store,
    prefs: { getPrefs, setPref, subscribePrefs },
    notify,
    services: { getService, getServiceProviders },
    dom: {
      mount: mountDomExtension,
      dispose: disposeDomExtension,
      isModule: isDomExtensionModule,
      anchors: OC_ANCHORS,
      version: DOM_STRATUM_VERSION,
    },
    kv: { forExt: extKv },
  };
}

/**
 * Install the surface on `window.__opencodeUI` (idempotent — first call
 * wins). Called once at boot from `main.tsx`; the runtime loader re-ensures
 * it before every manifest sync so the object always exists when a bundle
 * executes.
 */
export function installExtensionBridge(): ExtensionApi {
  const w = window as unknown as { __opencodeUI?: ExtensionApi };
  w.__opencodeUI ??= createExtensionApi();
  return w.__opencodeUI;
}

/** In-repo (shipped) extensions consume the identical surface via import. */
export function getExtensionApi(): ExtensionApi {
  return installExtensionBridge();
}
