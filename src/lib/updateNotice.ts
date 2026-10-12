/**
 * R11 update-notice state machine — pure helpers so the component stays
 * presentational and the "does not re-fire for the same version" rule is
 * testable without a DOM.
 *
 * The v2 TUI's `dialog-update.tsx` + `context/update-notification.tsx` walk a
 * fixed set of states; this mirrors that vocabulary. The de-dup key is the
 * target version: once the user skips (or dismisses) an available version, the
 * same version must never raise the notice again.
 */

export type UpdateNoticeState =
  | "checking"
  | "available"
  | "installing"
  | "installed"
  | "current"
  | "unavailable"
  | "failed";

export interface UpdateNoticeInput {
  state: UpdateNoticeState;
  /** The version being offered / installed. Null when not applicable. */
  version?: string | null;
  /** The version the user already skipped/dismissed for. */
  dismissedVersion?: string | null;
}

/**
 * Whether the notice should render at all. `checking`/`current` are silent;
 * an in-flight install or a pending restart always shows (the user must act);
 * an offered version is suppressed once dismissed for that same version.
 */
export function shouldShowUpdateNotice({
  state,
  version,
  dismissedVersion,
}: UpdateNoticeInput): boolean {
  if (state === "checking" || state === "current") return false;
  if (state === "installing" || state === "installed") return true;
  if (version && dismissedVersion && version === dismissedVersion) return false;
  return true;
}

/** Which primary actions a state offers, in render order. */
export function updateNoticeActions(
  state: UpdateNoticeState,
): Array<"skip" | "update" | "restart" | "retry" | "close"> {
  switch (state) {
    case "available":
      return ["skip", "update"];
    case "installing":
      return [];
    case "installed":
      return ["restart"];
    case "failed":
      return ["close", "retry"];
    default:
      return ["close"];
  }
}

// ---------------------------------------------------------------------------
// Persisted de-dup: "never show this version again"
// ---------------------------------------------------------------------------
//
// One localStorage key holds the version the user skipped. The store reads it
// when a check offers a version and suppresses the notice on a match; the
// notice host writes it on Skip. localStorage only (private-mode safe) — this is
// NOT the prefs system (owned elsewhere), so it lives here beside the rule it
// serves.

export const DISMISSED_UPDATE_VERSION_KEY = "webui.update.dismissedVersion";

export function getDismissedUpdateVersion(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
}

export function setDismissedUpdateVersion(version: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (version) localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version);
    else localStorage.removeItem(DISMISSED_UPDATE_VERSION_KEY);
  } catch {
    /* private mode / quota */
  }
}

/** A concise human message for a state. */
export function updateNoticeMessage(
  state: UpdateNoticeState,
  version?: string | null,
): string {
  switch (state) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return version ? `Version ${version} is available.` : "An update is available.";
    case "installing":
      return version ? `Installing ${version}…` : "Installing the update…";
    case "installed":
      return version
        ? `${version} installed — restart to apply.`
        : "Update installed — restart to apply.";
    case "current":
      return "You are on the latest version.";
    case "unavailable":
      return "Update checks are unavailable in this build.";
    case "failed":
      return "The update failed.";
  }
}
