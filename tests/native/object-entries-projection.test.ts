import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-entries-projection.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-entries-projection-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let binaries: ReadonlyArray<string>;
beforeAll(() => {
	const common = {
		fixture,
		outDir,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: { primordials: "mutable", eval: false, realms: false },
			surface: { node: true },
		}),
	};
	const pair = buildBackendPairFromOneProgramImage({ ...common, name: "projection" });
	binaries = [
		pair.compiled,
		pair.interpreted,
		buildNativeBinary({
			...common,
			name: "projection-precise",
			nativeStackRoots: "precise",
		}),
	];
});

describe("immediate Object.entries projections", () => {
	it.each([
		["keeps pairs and input fields rooted across loop collections", "loop"],
		["projects a constant index", "literal"],
		["preserves a missing constant index", "missing"],
		["preserves numeric and string index semantics", "indices"],
		["coerces the index after eagerly observing values", "coercion"],
		["observes getters deleting later properties", "delete"],
		["falls back for oversized records", "large"],
		["retains the captured method when a getter replaces it", "getter-rebind"],
		["retains the callee across argument effects", "argument-rebind"],
		["propagates an argument throw without calling the method", "argument-throw"],
		["propagates a getter throw without replay", "getter-throw"],
		["publishes the input before a replaced method observes it", "method"],
		["publishes the input before a replaced global observes it", "global"],
		["propagates a replacement result's property throw", "read-throw"],
		["preserves a lexical namespace replacement", "lexical"],
	])("%s", (_behavior, scenario) => {
		const env = { ENTRIES_PROJECT_CASE: scenario, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of binaries)
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
});
