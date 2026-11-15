import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-iteration-inline-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("inline Array iteration expansion", () => {
	let compiled: string;
	let interpreted: string;
	let source: string;
	let expected: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-iteration-inline.js",
			name: "array-iteration-inline",
			outDir,
		});
		({ compiled, interpreted } = pair);
		source = emitProgramImage(pair.programImage, { compiled: true });
		expected = execFileSync(process.execPath, ["tests/local/array-iteration-inline.js"], {
			encoding: "utf8",
		});
	}, 600_000);

	it("defines map and filter results through the private Array store contract", () => {
		expect(source).toContain("mal_vm_array_private_define_index(");
		expect(source).toContain("mal_vm_array_private_append(");
		expect(runToStdout(compiled)).toBe(expected);
	});

	it("preserves semantics under compiled GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});

	it("preserves interpreted semantics", () => {
		expect(runToStdout(interpreted)).toBe(expected);
	});
	it("matches Node under interpreted GC stress", () => {
		expect(runToStdout(interpreted, { env: STRESS_ENV })).toBe(expected);
	});
});

describe("private Array result growth", () => {
	let binaries: { compiled: string; interpreted: string };
	let expected: string;
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-iteration-growth.js",
			name: "array-iteration-growth",
			outDir,
		});
		expected = execFileSync(
			process.execPath,
			["--expose-gc", "tests/local/array-iteration-growth.js"],
			{ encoding: "utf8" },
		);
	});

	for (const backend of ["compiled", "interpreted"] as const)
		it(`preserves wide stores and object identity across ${backend} collections`, () => {
			// Full safepoint stress repeatedly scans the entire wide result. The fixture
			// instead collects at each capacity boundary while callback values are live.
			expect(
				runToStdout(binaries[backend], {
					env: { MAL_HOST_GC: "1", MAL_GC_VERIFY: "1" },
				}),
			).toBe(expected);
		});
});
