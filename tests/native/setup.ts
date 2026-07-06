/**
 * vitest globalSetup for the native lane. Builds the three runtime archives
 * (engine / host / runtime) + the Rust shim ONCE, before any native test runs, so
 * the parallel workers only emit + link their fixtures (they pass
 * `skipRuntimeBuild`) and never race a shared `cmake` on the build dir.
 */

import { ensureRuntimeLibrary } from "../../src/local-build.ts";

// vitest globalSetup supports a named `setup` export (avoids a default export).
export function setup(): void {
	ensureRuntimeLibrary(false);
}
