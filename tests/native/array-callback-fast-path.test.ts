import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
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
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-callback-fast-path.js",
			name: "array-callback-fast-path",
			outDir,
		}));
	});

	it("preserves compiled fast and fallback semantics", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("preserves captures under compiled GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("preserves interpreted fallback semantics", () => {
		assertResultPass(runToStdout(interpreted));
	});
});
