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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-path-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

// Native `node:path` (POSIX). The fixture runs the same acceptance suite under
// both the native codegen backend and the bytecode interpreter (path methods are
// plain native functions, dispatched identically by both), so a divergence in
// either tier fails. This includes embedded-NUL strings, which path handles
// lexically rather than as host filesystem paths. The Node compatibility surface
// is off by default, so every build opts in with `nodeEnabled`.
describe("node:path (POSIX)", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-path.mts",
			name: "nodepath-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-path.mts",
			name: "nodepath-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});
});

describe("node:path/posix", () => {
	it("shares path.posix values and survives replacement of the parent alias", () => {
		const fixture = "tests/local/node-path-posix.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-path-posix",
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
