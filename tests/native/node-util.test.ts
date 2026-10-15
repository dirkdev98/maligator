import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-util-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

interface TypeResults {
	identity: boolean;
	arrayBufferView: boolean;
	touched: boolean;
	construct: Array<[string, boolean | string]>;
	results: Array<[string, boolean, string, number, ...Array<boolean>]>;
}

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

describe("node:util Unicode conversion", () => {
	it("replaces unpaired surrogates with Node's coercion and intrinsic behavior", () => {
		const fixture = "tests/local/node-util-usv.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-util-usv",
			outDir,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env }).trim()).toBe(expected);
		}
	});
});

describe("node:util/types", () => {
	it("recognizes arguments and native errors without accepting forged brands", () => {
		const fixture = "tests/local/node-util-brands.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-util-brands",
			outDir,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env }).trim()).toBe(expected);
		}
	});
	it("keeps the original submodule after the parent property is replaced", () => {
		const fixture = "tests/local/node-util-types-cache.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-util-types-cache",
			outDir,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env }).trim()).toBe(expected);
		}
	});
	it("shares predicates with util.types and checks brands without reading properties", () => {
		const fixture = "tests/local/node-util-types.mjs";
		const expected = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as TypeResults;
		// The audited surface follows Node 26 wrappers; Node 24 differs in metadata and constructors.
		const node26Wrappers = new Set(["isDataView", "isKeyObject", "isCryptoKey"]);
		for (const row of expected.results) {
			if (node26Wrappers.has(row[0])) {
				row[2] = row[0];
				row[3] = 1;
			}
		}
		for (const row of expected.construct) if (node26Wrappers.has(row[0])) row[1] = true;
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-util-types",
			outDir,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				const actual = JSON.parse(runToStdout(binary, { env })) as TypeResults;
				expect(actual.identity).toBe(expected.identity);
				expect(actual.arrayBufferView).toBe(expected.arrayBufferView);
				// Older Node crypto predicates read proxy properties; our brand checks must not.
				expect(actual.touched).toBe(false);
				expect(actual.construct).toEqual(expected.construct);
				expect(actual.results).toHaveLength(expected.results.length);
				for (const [index, row] of actual.results.entries())
					expect(row, row[0]).toEqual(expected.results[index]);
			}
		}
	});
});
