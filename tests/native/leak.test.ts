import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
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

/**
 * Run `leaks --groupByType` against a binary under MAL_GC_AT_EXIT and assert zero
 * leaks. `--groupByType` clusters the report by the leaked C allocation's type, so
 * on failure the surfaced backtrace names the owned-allocation kind that leaked
 * (e.g. `MalMapEntry`, `MalModuleNamespaceExport`, the owned-concat `malloc`).
 */
function assertNoLeaks(fixture: string, name: string): void {
	const binary = buildNativeBinary({ fixture, name, outDir, skipRuntimeBuild: true });

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
	if (leaks !== 0 || bytes !== 0) {
		// Surface the grouped report so the failure names the leaking kind directly.
		const detail = output.slice(output.indexOf("leaks for") - 40).slice(0, 4000);
		throw new Error(
			`${name}: expected 0 leaks, got ${leaks} (${bytes} bytes):\n${detail}`,
		);
	}
}

describe.skipIf(!enabled)("GC leak audit (macOS `leaks`)", () => {
	// Every §A–D owned-allocation kind: object property tables (shaped + dictionary),
	// dense array element vectors, string code units (incl owned-concat), Map/Set
	// entry tables, ArrayBuffer backing stores, MalEnv closures + bound args,
	// generator/async-generator frame buffers, promise reaction lists, and the Rust
	// FFI handles (RegExp matcher, Intl Collator/PluralRules).
	it("leaks zero bytes at shutdown (object/array/string/map/set/buffer/closure/coroutine/promise/ffi)", () => {
		assertNoLeaks("tests/local/leakaudit.js", "leakcheck-leakaudit");
	});

	// The one kind leakaudit.js cannot reach from a single file: a module namespace's
	// malloc'd exports array (freed by the MAL_HEAP_MODULE_NAMESPACE_OBJECT finalizer).
	it("leaks zero bytes at shutdown (module-namespace exports)", () => {
		assertNoLeaks("tests/local/leakmodule.mjs", "leakcheck-leakmodule");
	});
});
