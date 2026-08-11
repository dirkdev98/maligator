import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-module-"));

describe("node:module", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-module.cjs",
			name: "node-module",
			outDir,
			nodeEnabled: true,
		});
	});

	it("provides the AOT-aware createRequire shape", () => {
		assertResultPass(runToStdout(bin));
	});
});
