import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-regexp-dispatch-"));

describe("String RegExp symbol dispatch", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/string-regexp-dispatch.js",
			name: "string-regexp-dispatch",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/string-regexp-dispatch.js",
			name: "string-regexp-dispatch-interpreted",
			compiled: false,
			outDir,
		});
	});

	it("uses current-spec dispatch in compiled code", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("uses current-spec dispatch in interpreted code", () => {
		assertResultPass(runToStdout(interpreted));
	});
});
