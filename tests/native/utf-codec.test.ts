import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-utf-codec-"));

describe("shared UTF codecs", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/utf_codec.mjs",
			name: "utf-codec",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("preserves replacement, NUL, empty, and allocation-boundary behavior", () => {
		assertResultPass(runToStdout(binary));
	});

	it("keeps decoded strings alive under GC stress", () => {
		assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
	});
});
