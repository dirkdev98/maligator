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

const fixture = "tests/local/object-entries-pair-fields.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-entry-pair-fields-"));
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
	const pair = buildBackendPairFromOneProgramImage({
		...common,
		name: "entry-pair-fields",
	});
	for (const name of [
		"readPair",
		"readStatic",
		"readLoop",
		"readJoined",
		"readJoinedWrapper",
		"readJoinedArithmetic",
	]) {
		const fn = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === name,
		)!;
		expect(
			fn.storage!.objectEnumerationSnapshots.some(
				(plan) => plan.entryProjections.length > 0,
			),
			name,
		).toBe(true);
		if (name.startsWith("readJoined")) {
			expect(fn.storage!.objectEnumerationSnapshots).toHaveLength(2);
			for (const plan of fn.storage!.objectEnumerationSnapshots)
				expect(plan.entryProjections).toHaveLength(1);
		}
	}
	binaries = [
		pair.compiled,
		pair.interpreted,
		buildNativeBinary({
			...common,
			name: "entry-pair-fields-precise",
			nativeStackRoots: "precise",
		}),
	];
});

describe("closed Object.entries pair fields", () => {
	it.each([
		["roots captured values after source mutation and index coercion", "captured"],
		["projects static string fields", "static"],
		["projects both fields before guarded producer joins", "joined"],
		["preserves replacement key, length and value getter order", "joined-replacement"],
		["preserves getter order after wrapper inlining", "joined-wrapper-replacement"],
		["preserves coercion before the next pair field", "joined-arithmetic"],
		["stops pair reads when preceding coercion throws", "joined-arithmetic-throw"],
		["throws normally for a missing guarded pair", "joined-missing"],
		["retains each pair index across loop collections", "loop"],
		["falls back for oversized records", "large"],
		["throws normally for missing pairs", "missing"],
		["retains cached pair identity and mutation", "cached"],
		["preserves old pairs across the next indexed read", "overlap"],
		["observes getters and deletion eagerly", "getter"],
		["executes replacement result accessors", "replacement"],
	])("%s", (_behavior, scenario) => {
		const env = { ENTRY_PAIR_CASE: scenario, MAL_HOST_GC: "1" };
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of binaries)
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
});
