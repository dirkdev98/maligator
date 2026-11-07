import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileEntrypoint } from "../../src/compiler/pipeline/compile-program.ts";
import {
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/commonjs-export-methods/main.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-commonjs-export-methods-"));

// A closed program, as production builds compile it.
describe("methods of required CommonJS modules", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const config = resolveBuildConfig({});
		const image = compileEntrypoint(path.resolve(fixture), { buildConfig: config });
		compiled = buildNativeProgramImage(image, {
			name: "commonjs-export-methods",
			config,
			outDir,
		});
		interpreted = buildNativeProgramImage(image, {
			name: "commonjs-export-methods-interpreted",
			config,
			outDir,
			compiled: false,
		});
	}, 600_000);

	it("dispatches replaced methods and objects like Node in both backends", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps that dispatch under GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});
});
