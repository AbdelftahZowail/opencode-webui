/**
 * Skill auto-sync: the repo's skills/webui/SKILL.md is the agent-side manual
 * for driving this webui. It is copied into the user's opencode skill dir on
 * every boot (overwrite = sync, so repo edits propagate) and can be installed
 * standalone via `--install-skill`. Failures are reported, never fatal — a
 * missing/readonly skill must not take the proxy down with it.
 *
 * The source is read through Bun.file, not node:fs: on a real checkout that is
 * an ordinary disk path, but inside a `bun build --compile` binary SOURCE is a
 * virtual "/$bunfs/..." path that node:fs cannot see — scripts/embed-shim.ts
 * maps it onto the copy embedded in the executable (scripts/embed-dist.ts
 * embeds skills/webui/SKILL.md alongside the dist/ assets).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Lives next to the server source so it works from any cwd. */
const SOURCE = new URL("../skills/webui/SKILL.md", import.meta.url).pathname;

export function skillTargetPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "skills", "webui", "SKILL.md");
}

export type SkillSyncResult = { ok: boolean; target: string; reason?: string };

export async function syncSkill(): Promise<SkillSyncResult> {
  const target = skillTargetPath();
  try {
    let text: string;
    try {
      text = await Bun.file(SOURCE).text();
    } catch {
      return { ok: false, target, reason: `source missing: ${SOURCE}` };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    return { ok: true, target };
  } catch (err) {
    return {
      ok: false,
      target,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
