/**
 * Entrypoint for compiled binaries only (see scripts/build-binary.sh):
 *
 *   bun build --compile scripts/compile-entry.ts --target=bun-<target>
 *
 * Import order matters: embed-shim patches Bun.file for the binary's virtual
 * dist path BEFORE server/index.ts initializes its static handler, so the
 * compiled binary serves the embedded frontend. Do not run this file directly
 * — dev (`bun run dev`) and npm (`bun run server/index.ts`) use the plain
 * server/index.ts entry.
 */
import "./embed-shim";
import "../server/index";
