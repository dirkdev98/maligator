import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-iteration-inline-"));

describe("inline Array iteration expansion", () => {
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	let source: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-iteration-inline.js",
			name: "array-iteration-inline",
			outDir,
		});
		({ compiled, interpreted } = pair);
		source = emitProgramImage(pair.programImage, { compiled: true });
	}, 600_000);

	it("defines map and filter results through the dense vector", () => {
		expect(source).toContain("mal_vm_array_try_define_index(");
		assertResultPass(runToStdout(compiled));
	});

	it("preserves semantics under compiled GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("preserves interpreted semantics", () => {
		assertResultPass(runToStdout(interpreted));
	});
});
