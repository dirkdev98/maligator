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

const fixture = "tests/local/module-evaluator-cells.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-module-evaluator-cells-"));

// A closed program, as production builds compile it.
describe("module evaluator cells", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const config = resolveBuildConfig({});
		const image = compileEntrypoint(path.resolve(fixture), { buildConfig: config });
		compiled = buildNativeProgramImage(image, {
			name: "module-evaluator-cells",
			config,
			outDir,
		});
		interpreted = buildNativeProgramImage(image, {
			name: "module-evaluator-cells-interpreted",
			config,
			outDir,
			compiled: false,
		});
	}, 600_000);

	it("reads module cells like Node in both backends", () => {
		expect(runToStdout(compiled)).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("keeps those reads under GC stress", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});
});
