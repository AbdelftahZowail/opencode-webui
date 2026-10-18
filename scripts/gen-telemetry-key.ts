#!/usr/bin/env bun
/**
 * Bakes the telemetry ingest key into the **npm** release artifact.
 *
 *   WEBUI_TELEMETRY_KEY=<hub write key> bun run gen:telemetry-key
 *
 * Writes `<repo>/dist/telemetry-key.json`, which `server/telemetry.ts` reads as
 * a fallback after `WEBUI_TELEMETRY_KEY` (see `telemetryKey()`). `dist/` is both
 * PACKED into the npm tarball and GITIGNORED, so the key ships in the release
 * without ever entering git — the same shape the Quickly app uses (a build-time
 * secret: `QUICKLY_TELEMETRY_KEY=${{ secrets.QUICKLY_TELEMETRY_KEY }}`).
 *
 * npm ONLY. A compiled binary is inert by channel (`updateChannel() → "binary"`
 * makes `releaseVersion()` null), so embedding a key there would accomplish
 * nothing — do not wire this into the binary build.
 *
 * DELIBERATELY FAILS (exit 1) when the key is missing, because an artifact that
 * ships without one collects NOTHING and every other gate stays green — the
 * silent failure that shipped in 3.4.0/3.4.1. Run by `prepublishOnly`.
 *
 *   bun run scripts/gen-telemetry-key.ts [--out <file>]   (--out: tests only)
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const explicitOut = outFlag >= 0;
const outArg = explicitOut ? (argv[outFlag + 1] ?? "") : "";
if (explicitOut && (!outArg || outArg.startsWith("--"))) {
  console.error("[gen-telemetry-key] --out needs a file path (it exists for tests; a release uses the default).");
  process.exit(1);
}
const outFile = explicitOut ? resolve(outArg) : join(repoRoot, "dist", "telemetry-key.json");
// The key must never land somewhere `git add` would pick it up: dist/ is the
// only in-repo location that is both packed and ignored.
if (explicitOut && outFile.startsWith(resolve(repoRoot) + sep) && !outFile.startsWith(join(repoRoot, "dist") + sep)) {
  console.error(
    `[gen-telemetry-key] refusing to write the key inside the repo outside dist/: ${relative(repoRoot, outFile)}`,
  );
  process.exit(1);
}

const key = (process.env.WEBUI_TELEMETRY_KEY ?? "").trim();
if (!key) {
  console.error(
    "[gen-telemetry-key] WEBUI_TELEMETRY_KEY is not set — refusing to produce an artifact that\n" +
      "  would collect nothing.\n" +
      "  Set it to the hub's write key (HUB_WRITE_KEY in the hub's .env) and re-run.\n" +
      "  Prefer the publishing shell or a CI secret over a .env file, and never commit it.",
  );
  process.exit(1);
}

if (!explicitOut && !existsSync(join(repoRoot, "dist"))) {
  console.error("[gen-telemetry-key] dist/ not found — run `bun run build` first.");
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify({ key }, null, 2)}\n`, { mode: 0o600 });
// `mode` only applies when the file is created; tighten an existing one too.
chmodSync(outFile, 0o600);
// Never print the key itself — only its length.
console.log(
  `[gen-telemetry-key] baked the ingest key (${key.length} chars) -> ${relative(repoRoot, outFile)}`,
);
