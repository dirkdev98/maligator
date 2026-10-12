import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supportedNodeBuiltinNames } from "../../src/compiler/frontend/host-modules.ts";
import {
	assertResultPass,
	buildNativeBinary,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-module-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

interface BuiltinResults {
	names: Array<string>;
	loadable: boolean;
	prefixOnly: boolean;
	identity: boolean;
	valid: boolean;
	frozen: boolean;
	mutation: string;
	invalid: Array<boolean>;
	coerced: boolean;
	unsupported: Array<boolean>;
}

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

describe("node:module builtin registry", () => {
	it("lists supported imports with Node's prefix, validation, and frozen-array behavior", () => {
		const fixture = "tests/local/node-builtin-modules.mjs";
		const oracle = JSON.parse(
			execFileSync(process.execPath, [fixture], { encoding: "utf8" }),
		) as BuiltinResults;
		const names = supportedNodeBuiltinNames();
		expect(names).toEqual(oracle.names.filter((name: string) => names.includes(name)));
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-builtin-modules",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				const actual = JSON.parse(runToStdout(binary, { env })) as BuiltinResults;
				expect(actual).toEqual({
					...oracle,
					names,
					unsupported: [false, false, false, false],
				});
			}
		}
	});
});
