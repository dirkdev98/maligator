import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-assert-"));

describe("node:assert", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-assert.cjs",
			name: "node-assert",
			outDir,
			nodeEnabled: true,
		});
	});

	it("supports callable and named strict assertions", () => {
		assertResultPass(runToStdout(bin));
	});
});
