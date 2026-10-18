/**
 * testkit-echo — browser stratum (fixture).
 *
 * The smallest real browser contribution: register one inert service value.
 * Its job in the harness is to prove the BUNDLE built, was served, and
 * EXECUTED in the page (the marker string is greppable from the served bundle
 * and the service id is verifiable in-page). The visible, user-facing proof of
 * the browser half lives in `dom.ts`.
 *
 * External bundles reach core through the one extension API surface
 * (`window.__opencodeUI`), mirroring how the shipped `report` extension consumes
 * it — so this fixture exercises the public contract, not repo internals.
 */

type ExtApi = {
  register: (ext: Record<string, unknown>) => void;
};

export const id = "testkit-echo";

const api = (globalThis as unknown as { __opencodeUI?: ExtApi }).__opencodeUI;

if (api && typeof api.register === "function") {
  api.register({
    kind: "service",
    id: "testkit-echo.browser",
    service: "testkit.echo",
    value: { marker: "TESTKIT_ECHO_BROWSER" },
    precedence: 1000,
  });
}
