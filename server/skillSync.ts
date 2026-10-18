import { fileURLToPath } from "node:url";
/**
 * Skill auto-sync: the repo's `skills/<id>/SKILL.md` files are the agent-side
 * manuals that ship with the app — `webui` (driving this webui / authoring
 * extensions) and `testkit` (the isolated real-client test harness). Each is
 * copied into the user's opencode skill dir on every boot (overwrite = sync, so
 * repo edits propagate) and can be installed standalone via `--install-skill`.
 * Failures are reported, never fatal — a missing/readonly skill must not take
 * the proxy down with it.
 *
 * The source is read through Bun.file, not node:fs: on a real checkout that is
 * an ordinary disk path, but inside a `bun build --compile` binary SOURCE is a
 * virtual "/$bunfs/..." path that node:fs cannot see — scripts/embed-shim.ts
 * maps it onto the copy embedded in the executable (scripts/embed-dist.ts
 * embeds each skills/<id>/SKILL.md alongside the dist/ assets).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The skills this build ships, in install order (id = folder under skills/). */
const SKILL_IDS = ["webui", "testkit"] as const;

/** Source path for one shipped skill — works from any cwd, checkout or binary. */
function skillSource(id: string): string {
  return fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url));
}

export function skillTargetPath(id: string = "webui"): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "opencode", "skills", id, "SKILL.md");
}

export type SkillSyncResult = {
  ok: boolean;
  /** Install targets, comma-joined when more than one skill shipped. */
  target: string;
  reason?: string;
};

export async function syncSkill(): Promise<SkillSyncResult> {
  const targets: string[] = [];
  const reasons: string[] = [];
  for (const id of SKILL_IDS) {
    const target = skillTargetPath(id);
    const source = skillSource(id);
    try {
      let text: string;
      try {
        text = await Bun.file(source).text();
      } catch {
        reasons.push(`${id}: source missing: ${source}`);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      targets.push(target);
    } catch (err) {
      reasons.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    ok: reasons.length === 0,
    // Never an empty string: a total failure still names where it would land.
    target: targets.length > 0 ? targets.join(", ") : skillTargetPath(),
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
  };
}
