import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeBinary } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-leak-"));

// `leaks` is macOS-only and slow, so this is opt-in (MAL_LEAKCHECK=1 — see the
// test:leak npm script), never part of bare `npm test`. The teardown
// (test262_main under MAL_GC_AT_EXIT) forces a final full GC and frees every
// reclaimable allocation, so a leak the tool reports is a genuine finalizer gap.
const enabled = os.platform() === "darwin" && process.env.MAL_LEAKCHECK === "1";

/** Parse the "Process N: K leaks for M total leaked bytes." line from `leaks`. */
function parseLeaks(output: string): { leaks: number; bytes: number } {
	const match = output.match(/(\d+) leaks for (\d+) total leaked bytes/);
	if (!match) {
		throw new Error(`could not parse leaks output:\n${output.slice(0, 2000)}`);
	}
	return { leaks: Number(match[1]), bytes: Number(match[2]) };
}

describe.skipIf(!enabled)("GC leak audit (macOS `leaks`)", () => {
	it("leaks zero bytes at shutdown", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/leakaudit.js",
			name: "leakcheck-leakaudit",
			outDir,
			skipRuntimeBuild: true,
		});

		let output = "";
		try {
			output = execFileSync("leaks", ["--atExit", "--groupByType", "--", binary], {
				env: { ...process.env, MAL_GC_AT_EXIT: "1" },
				encoding: "utf-8",
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch (error) {
			// `leaks` exits non-zero when it finds leaks; its report is still on stdout.
			output = (error as { stdout?: string }).stdout ?? "";
		}

		const { leaks, bytes } = parseLeaks(output);
		expect({ leaks, bytes }).toEqual({ leaks: 0, bytes: 0 });
	});
});
