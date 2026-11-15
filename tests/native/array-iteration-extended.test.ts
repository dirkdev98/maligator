import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-iteration-extended.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-extended-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each([
	{ name: "locked", config: resolveBuildConfig({}) },
	{
		name: "mutable realms",
		config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
	},
])("extended Array callback loops ($name)", ({ config }) => {
	let binaries: { compiled: string; interpreted: string };
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: `array-extended-${config.engine.primordials}`,
			config,
			outDir,
		});
	});
	it("matches traversal, seeding and flattening behavior", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [binaries.compiled, binaries.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});
