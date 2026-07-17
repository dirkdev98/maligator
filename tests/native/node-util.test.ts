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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-util-"));

describe("node:util", () => {
	let esmCompiled: string;
	let esmInterpreted: string;
	let cjsCompiled: string;
	let cjsInterpreted: string;

	beforeAll(() => {
		esmCompiled = buildNativeBinary({
			fixture: "tests/local/node-util.mjs",
			name: "node-util-esm-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		esmInterpreted = buildNativeBinary({
			fixture: "tests/local/node-util.mjs",
			name: "node-util-esm-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		cjsCompiled = buildNativeBinary({
			fixture: "tests/local/node-util.cjs",
			name: "node-util-cjs-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		cjsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-util.cjs",
			name: "node-util-cjs-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes ESM compiled", () => {
		assertResultPass(runToStdout(esmCompiled));
	});

	it("passes ESM interpreted", () => {
		assertResultPass(runToStdout(esmInterpreted));
	});

	it("passes CommonJS compiled", () => {
		assertResultPass(runToStdout(cjsCompiled));
	});

	it("passes CommonJS interpreted", () => {
		assertResultPass(runToStdout(cjsInterpreted));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(esmCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(cjsCompiled, { env: STRESS_ENV }));
	});
});
