#!/usr/bin/env bash
#
# Build self-contained opencode-webui binaries via `bun build --compile`.
#
# The frontend (dist/) is EMBEDDED into each executable:
#   1. dist/ is built if missing (bun run build)
#   2. scripts/embed-dist.ts generates scripts/generated/assets.ts, importing
#      every dist/ file `with { type: "file" }` (embeds the bytes)
#   3. scripts/compile-entry.ts (embed-shim + server/index.ts) is compiled per
#      target; scripts/embed-shim.ts maps the server's virtual dist path onto
#      the embedded files, so the binary needs no adjacent dist/ folder
#
# Outputs (cleaned on every run — idempotent):
#   release/opencode-webui-<target>[.exe]        raw binaries
#   release/opencode-webui-<target>.tar.gz       release tarballs (keeps +x)
#   release/SHA256SUMS.txt                       sha256 of the tarballs
#
# Usage: scripts/build-binary.sh [target ...]
#   target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | windows-x64
#   (no args = all five)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL_TARGETS=(linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64)
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("${ALL_TARGETS[@]}")
fi

RELEASE_DIR="$ROOT/release"

# 1. Frontend build (embedded into the binaries).
if [ ! -f dist/index.html ]; then
  echo "[build-binary] dist/ missing — running: bun install && bun run build"
  bun install
  bun run build
fi

# 2. Embedded-asset manifest for the compiler.
bun run scripts/embed-dist.ts

# 3. Clean previous outputs.
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# 4. Compile per target and package.
for target in "${TARGETS[@]}"; do
  case " ${ALL_TARGETS[*]} " in
    *" $target "*) ;;
    *) echo "[build-binary] unknown target: $target (known: ${ALL_TARGETS[*]})" >&2; exit 1 ;;
  esac

  name="opencode-webui-$target"
  out="$RELEASE_DIR/$name"
  [ "$target" = "windows-x64" ] && out="$out.exe"

  echo "[build-binary] compiling $target -> $out"
  bun build --compile scripts/compile-entry.ts --target="bun-$target" --outfile "$out"

  echo "[build-binary] packaging $name.tar.gz"
  tar -czf "$RELEASE_DIR/$name.tar.gz" -C "$RELEASE_DIR" "$(basename "$out")"
done

# 5. Checksums (tarballs are the release artifacts).
(
  cd "$RELEASE_DIR"
  # macOS has no GNU coreutils — fall back to the perl shasum.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum ./*.tar.gz > SHA256SUMS.txt
  else
    shasum -a 256 ./*.tar.gz > SHA256SUMS.txt
  fi
)

echo "[build-binary] done:"
ls -la "$RELEASE_DIR"
