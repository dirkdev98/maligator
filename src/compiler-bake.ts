import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

/**
 * Generate the baked-compiler wire buffer for runtime `eval` (eval Phase 3/4).
 *
 * maligator (the Node-hosted compiler) AOT-compiles `eval-compiler-entry.mts`
 * and its `compileSourceToBuffer` cone into `runtime/src/compiler.malw`, which
 * `compiler_wire.c` `#embed`s into LibMaligator. This must run before the cmake
 * build (the GLOB pulls in compiler_wire.c, whose `#embed` needs the file to
 * exist), so `ensureRuntimeLibrary` calls it first.
 *
 * Regenerated when missing or stale (any `src` source newer than the buffer) so
 * an edit to the compiler reflows into the baked copy — eval would otherwise run
 * a stale compiler and silently miscompile. Set `MAL_BAKE=skip` to reuse an
 * existing buffer during fast unrelated iteration.
 */

const ENTRY = "src/eval-compiler-entry.mts";
const WIRE = "runtime/src/compiler.malw";

/** Newest mtime (ms) among the compiler sources under `src/`. */
function newestSourceMtime(): number {
	let newest = 0;
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
				const m = statSync(full).mtimeMs;
				if (m > newest) newest = m;
			}
		}
	};
	walk("src");
	return newest;
}

/**
 * Ensure `runtime/src/compiler.malw` is present and current. Returns the path.
 */
export function ensureCompilerWire(verbose: boolean): string {
	const exists = existsSync(WIRE);
	if (exists && process.env.MAL_BAKE === "skip") return WIRE;

	const wireMtime = exists ? statSync(WIRE).mtimeMs : 0;
	if (exists && wireMtime >= newestSourceMtime()) return WIRE;

	execFileSync("node", ["src/index.ts", ENTRY, "--serialize", WIRE], {
		stdio: verbose ? "inherit" : "ignore",
	});
	return WIRE;
}
