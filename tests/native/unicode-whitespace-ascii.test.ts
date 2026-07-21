import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-unicode-whitespace-ascii-"));

describe("Unicode scalar, ECMAScript whitespace, and ASCII helpers", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/unicode-whitespace-ascii.mjs",
			name: "unicode-whitespace-ascii",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("preserves each caller policy and recognizes the complete whitespace set", () => {
		assertResultPass(runToStdout(binary));
	});
});
