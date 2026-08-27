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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-regexp-dispatch-"));

describe("String RegExp symbol dispatch", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/string-regexp-dispatch.js",
			name: "string-regexp-dispatch",
			outDir,
		}));
	});

	it("uses current-spec dispatch in compiled code", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("uses current-spec dispatch in interpreted code", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("uses current-spec compiled dispatch under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("uses current-spec interpreted dispatch under GC stress", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
