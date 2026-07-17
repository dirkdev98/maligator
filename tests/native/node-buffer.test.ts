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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-buffer-"));

describe("global Buffer and node:buffer", () => {
	let esmCompiled: string;
	let esmInterpreted: string;
	let cjsCompiled: string;
	let cjsInterpreted: string;
	let globalOnly: string;
	let expressDependencySmoke: string;

	beforeAll(() => {
		esmCompiled = buildNativeBinary({
			fixture: "tests/local/node-buffer.mjs",
			name: "node-buffer-esm-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		esmInterpreted = buildNativeBinary({
			fixture: "tests/local/node-buffer.mjs",
			name: "node-buffer-esm-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		cjsCompiled = buildNativeBinary({
			fixture: "tests/local/node-buffer.cjs",
			name: "node-buffer-cjs-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		cjsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-buffer.cjs",
			name: "node-buffer-cjs-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		globalOnly = buildNativeBinary({
			fixture: "tests/local/node-buffer-global.mjs",
			name: "node-buffer-global",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		expressDependencySmoke = buildNativeBinary({
			fixture: "tests/fixtures/express-5/buffer-smoke.cjs",
			name: "node-buffer-express-dependency-smoke",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
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

	it("installs Buffer for a free global without an import", () => {
		assertResultPass(runToStdout(globalOnly));
	});

	it("supports Express's safer-buffer dependency", () => {
		assertResultPass(runToStdout(expressDependencySmoke));
	});

	it("passes compiled paths under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(esmCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(cjsCompiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(globalOnly, { env: STRESS_ENV }));
		assertResultPass(runToStdout(expressDependencySmoke, { env: STRESS_ENV }));
	});
});
