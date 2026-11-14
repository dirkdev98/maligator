import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/async-activation.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-async-activation-"));
const binaries: Array<string> = [];
const mutableBinaries: Array<string> = [];
let expected: string;
let mutableExpected: string;

beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	for (const primordials of ["locked", "mutable"] as const) {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `async-activation-${primordials}`,
			mainFile: HOST_MAIN,
			outDir,
			config: resolveBuildConfig({ surface: { node: true }, engine: { primordials } }),
		});
		binaries.push(pair.compiled, pair.interpreted);
	}
	const mutableFixture = "tests/local/async-activation-mutable.mjs";
	mutableExpected = execFileSync(process.execPath, [mutableFixture], {
		encoding: "utf8",
	});
	const pair = buildBackendPairFromOneProgramImage({
		fixture: mutableFixture,
		name: "async-activation-mutations",
		mainFile: HOST_MAIN,
		outDir,
		config: resolveBuildConfig({
			surface: { node: true },
			engine: { primordials: "mutable" },
		}),
	});
	mutableBinaries.push(pair.compiled, pair.interpreted);
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("preserves completion and microtask ordering before and after the first suspension", () => {
	for (const binary of binaries) expect(runToStdout(binary)).toBe(expected);
});

it("retains lazy activations and inline or pooled snapshots through collections", () => {
	for (const binary of binaries)
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
});

it("observes constructor getters and replacement resolve methods during await", () => {
	for (const binary of mutableBinaries) {
		expect(runToStdout(binary)).toBe(mutableExpected);
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(mutableExpected);
	}
});
