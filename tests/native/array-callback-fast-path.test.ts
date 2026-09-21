import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { expect } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-callback-fast-path-"));

describe("guarded Array callback fast paths", () => {
	let compiled: string;
	let interpreted: string;
	let source: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-callback-fast-path.js",
			name: "array-callback-fast-path",
			outDir,
		});
		({ compiled, interpreted } = pair);
		source = emitProgramImage(pair.programImage, { compiled: true });
	});

	it("preserves compiled fast and fallback semantics", () => {
		expect(source).toContain("mal_vm_array_try_get_present_proven_index(");
		expect(source).toMatch(
			/__array_presence_\d+_value = __indexed_length_\d+_array->elements/,
		);
		expect(source).toMatch(/__paired_array_\d+_secondary->elements/);
		assertResultPass(runToStdout(compiled));
	});

	it("preserves captures under compiled GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("preserves interpreted fallback semantics", () => {
		assertResultPass(runToStdout(interpreted));
	});
});
