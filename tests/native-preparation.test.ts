import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import { perfStatsDefines } from "../src/build-flags.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import type { NativeBuildContextOptions } from "../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../src/runtime-build.ts";
import { setup } from "./native/setup.ts";

vi.mock("../src/native-build-context.ts", () => ({
	resolveNativeBuildContext: vi.fn((options: NativeBuildContextOptions) => options),
}));
vi.mock("../src/runtime-build.ts", () => ({ ensureNativeArtifacts: vi.fn() }));

function selectedProject(...files: Array<string>): TestProject {
	return {
		vitest: {
			state: {
				getPaths: () => files.map((file) => path.resolve("tests/native", file)),
				getFilepaths: () => [],
			},
		},
	} as unknown as TestProject;
}

function preparedContexts(): Array<NativeBuildContextOptions> {
	return vi.mocked(resolveNativeBuildContext).mock.calls.map(([options]) => options!);
}

describe("native runtime preparation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("MAL_NATIVE_PREWARM", undefined);
		vi.stubEnv("MAL_PERF_STATS", undefined);
		vi.stubEnv("MAL_PREPARATION_BUILD_JOBS", "4");
		vi.stubEnv("MAL_BUILD_JOBS", "2");
		vi.stubEnv("CARGO_BUILD_JOBS", "2");
	});

	afterEach(() => vi.unstubAllEnvs());

	it.each([
		"map-get-set-cache.test.ts",
		"array-push-direct.test.ts",
		"collection-direct.test.ts",
		"object-rest-shaped.test.ts",
		"own-table-property-cache.test.ts",
	])("prepares both shared runtime variants for %s before its hooks", (file) => {
		setup(selectedProject(file));
		const contexts = preparedContexts();
		expect(contexts).toHaveLength(2);
		expect(contexts.map((context) => perfStatsDefines(context.environment))).toEqual([
			[],
			["-DMAL_PERF_STATS=1"],
		]);
		for (const [index, context] of contexts.entries()) {
			expect(context.features).toMatchObject({
				evalEnabled: true,
				realmsEnabled: true,
				intlEnabled: true,
				temporalEnabled: true,
				webPlatformEnabled: true,
				nodeEnabled: false,
				profileEnabled: false,
			});
			expect(context.environment).toMatchObject({
				MAL_BUILD_JOBS: "4",
				CARGO_BUILD_JOBS: "4",
			});
			expect(ensureNativeArtifacts).toHaveBeenNthCalledWith(index + 1, context);
		}
	});

	it("prepares the instrumented archive once for multiple selected consumers", () => {
		setup(selectedProject("map-get-set-cache.test.ts", "collection-direct.test.ts"));
		expect(ensureNativeArtifacts).toHaveBeenCalledTimes(2);
	});

	it.each([
		"gc.test.ts",
		"node-events.test.ts",
		"object-spread-shaped.test.ts",
		"profile.test.ts",
		"interpreter-dense-array.test.ts",
	])("keeps %s outside default instrumented preparation", (file) => {
		setup(selectedProject(file));
		expect(preparedContexts()).toHaveLength(1);
		expect(perfStatsDefines(preparedContexts()[0]!.environment)).toEqual([]);
	});

	it("does not change the inherited runtime mode or worker allocation", () => {
		vi.stubEnv("MAL_UBSAN", "1");
		const inherited = { ...process.env };
		setup(selectedProject("map-get-set-cache.test.ts"));
		expect(process.env).toEqual(inherited);
		const [ordinary, instrumented] = preparedContexts();
		expect(ordinary!.environment).not.toBe(instrumented!.environment);
		expect(ordinary!.environment?.MAL_PERF_STATS).toBeUndefined();
		expect(instrumented!.environment?.MAL_PERF_STATS).toBe("1");
		for (const context of [ordinary!, instrumented!]) {
			expect(context.environment?.MAL_UBSAN).toBe("1");
		}
	});

	it("retains inherited performance instrumentation without duplicate preparation", () => {
		vi.stubEnv("MAL_PERF_STATS", "1");
		setup(selectedProject("map-get-set-cache.test.ts"));
		expect(preparedContexts()).toHaveLength(1);
		expect(perfStatsDefines(preparedContexts()[0]!.environment)).toEqual([
			"-DMAL_PERF_STATS=1",
		]);
	});

	it("preserves the inherited build budget when no preparation override is set", () => {
		vi.stubEnv("MAL_PREPARATION_BUILD_JOBS", undefined);
		setup(selectedProject("map-get-set-cache.test.ts"));
		for (const context of preparedContexts()) {
			expect(context.environment).toMatchObject({
				MAL_BUILD_JOBS: "2",
				CARGO_BUILD_JOBS: "2",
			});
		}
	});

	it("honors disabled prewarming even when an instrumented fixture is selected", () => {
		vi.stubEnv("MAL_NATIVE_PREWARM", "0");
		setup(selectedProject("map-get-set-cache.test.ts"));
		expect(resolveNativeBuildContext).not.toHaveBeenCalled();
		expect(ensureNativeArtifacts).not.toHaveBeenCalled();
	});
});
