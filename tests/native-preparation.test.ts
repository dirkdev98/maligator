import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript-v6-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import { perfStatsDefines } from "../src/build-flags.ts";
import { resolveNativeBuildContext } from "../src/native-build-context.ts";
import type { NativeBuildContextOptions } from "../src/native-build-context.ts";
import { ensureNativeArtifacts } from "../src/runtime-build.ts";
import type { BuildOptions } from "../src/test-harness.ts";
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

function implicitInstrumentedConsumers(): Array<{ file: string; node: boolean }> {
	const overrides = new Set<keyof BuildOptions>([
		"config",
		"evalEnabled",
		"realmsEnabled",
		"intlEnabled",
		"intlFeatures",
		"webPlatformEnabled",
		"regexpEnabled",
		"temporalEnabled",
		"profileEnabled",
		"production",
		"compilerBake",
		"cacheDirectory",
	]);
	const builders = new Map([
		["buildNativeBinary", 0],
		["buildNativeBinaryResult", 0],
		["buildNativeProgramImage", 1],
		["buildNativeProgramImageResult", 1],
		["buildBackendPairFromOneProgramImage", 0],
	]);
	const consumers: Array<{ file: string; node: boolean }> = [];
	for (const file of readdirSync("tests/native", {
		recursive: true,
		encoding: "utf8",
	}).sort()) {
		if (!file.endsWith(".test.ts")) continue;
		const source = ts.createSourceFile(
			file,
			readFileSync(path.join("tests/native", file), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const imported = new Map<string, number>();
		for (const statement of source.statements) {
			if (
				!ts.isImportDeclaration(statement) ||
				!ts.isStringLiteral(statement.moduleSpecifier) ||
				!statement.moduleSpecifier.text.endsWith("/test-harness.ts")
			)
				continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
			for (const binding of bindings.elements) {
				const index = builders.get((binding.propertyName ?? binding.name).text);
				if (index !== undefined) imported.set(binding.name.text, index);
			}
		}
		const profiles = new Set<boolean>();
		// Importing native modules would execute their process and temporary-directory setup.
		const visit = (expression: ts.Node): void => {
			if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
				const index = imported.get(expression.expression.text);
				const options = index === undefined ? undefined : expression.arguments[index];
				if (options !== undefined && ts.isObjectLiteralExpression(options)) {
					const properties = new Map<string, ts.Expression>();
					let implicit = true;
					for (const property of options.properties) {
						if (
							(ts.isPropertyAssignment(property) ||
								ts.isShorthandPropertyAssignment(property)) &&
							(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
						) {
							const name = property.name.text;
							if (overrides.has(name as keyof BuildOptions)) implicit = false;
							properties.set(
								name,
								ts.isPropertyAssignment(property) ? property.initializer : property.name,
							);
						} else {
							implicit = false;
						}
					}
					const environment = properties.get("environment");
					const node = properties.get("nodeEnabled");
					if (
						implicit &&
						(node === undefined ||
							node.kind === ts.SyntaxKind.TrueKeyword ||
							node.kind === ts.SyntaxKind.FalseKeyword) &&
						environment !== undefined &&
						ts.isObjectLiteralExpression(environment) &&
						environment.properties.some(
							(property, index) =>
								!environment.properties.slice(index + 1).some(ts.isSpreadAssignment) &&
								ts.isPropertyAssignment(property) &&
								(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
								property.name.text === "MAL_PERF_STATS" &&
								ts.isStringLiteral(property.initializer) &&
								property.initializer.text === "1",
						)
					)
						profiles.add(node?.kind === ts.SyntaxKind.TrueKeyword);
				}
			}
			ts.forEachChild(expression, visit);
		};
		visit(source);
		for (const node of profiles) consumers.push({ file, node });
	}
	return consumers;
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

	it.each(implicitInstrumentedConsumers())(
		"prepares the selected instrumented profile for $file before hooks",
		({ file, node }) => {
			setup(selectedProject(file));
			const contexts = preparedContexts();
			expect(contexts).toHaveLength(3);
			expect(contexts.map((context) => perfStatsDefines(context.environment))).toEqual([
				[],
				[],
				["-DMAL_PERF_STATS=1"],
			]);
			expect(contexts.map((context) => context.features?.nodeEnabled)).toEqual([
				false,
				true,
				node,
			]);
			for (const [index, context] of contexts.entries()) {
				expect(context.features).toMatchObject({
					evalEnabled: true,
					realmsEnabled: true,
					intlEnabled: true,
					temporalEnabled: true,
					webPlatformEnabled: true,
					profileEnabled: false,
				});
				expect(context.environment).toMatchObject({
					MAL_BUILD_JOBS: "4",
					CARGO_BUILD_JOBS: "4",
				});
				expect(ensureNativeArtifacts).toHaveBeenNthCalledWith(index + 1, context);
			}
		},
	);

	it("prepares the instrumented archive once for multiple selected consumers", () => {
		setup(selectedProject("map-get-set-cache.test.ts", "collection-direct.test.ts"));
		expect(ensureNativeArtifacts).toHaveBeenCalledTimes(3);
	});

	it("prepares the web-disabled runtime before its timed hook without instrumenting that variant", () => {
		setup(selectedProject("web-disabled.test.ts", "collection-direct.test.ts"));
		const contexts = preparedContexts();
		expect(contexts).toHaveLength(4);
		const webDisabled = contexts.filter(
			(context) => context.features?.webPlatformEnabled === false,
		);
		expect(webDisabled).toHaveLength(1);
		expect(webDisabled[0]!.features?.nodeEnabled).toBe(false);
		expect(perfStatsDefines(webDisabled[0]!.environment)).toEqual([]);
		expect(webDisabled[0]!.environment).toMatchObject({
			MAL_BUILD_JOBS: "4",
			CARGO_BUILD_JOBS: "4",
		});
		expect(ensureNativeArtifacts).toHaveBeenCalledWith(webDisabled[0]);
	});

	it("prepares the realms-disabled profile before its timed hook", () => {
		setup(selectedProject("realms-disabled.test.ts"));
		const contexts = preparedContexts();
		expect(contexts.map((context) => context.features?.realmsEnabled)).toEqual([
			true,
			true,
			false,
		]);
		expect(contexts.at(-1)?.features).toMatchObject({
			nodeEnabled: false,
			webPlatformEnabled: true,
		});
		expect(ensureNativeArtifacts).toHaveBeenCalledWith(contexts.at(-1));
	});

	it("prepares Node instrumentation for the HTTP queue lifecycle fixture", () => {
		setup(selectedProject("node-http-ready-queues.test.ts"));
		const contexts = preparedContexts();
		expect(contexts.map((context) => context.features?.nodeEnabled)).toEqual([
			false,
			true,
			true,
		]);
		expect(contexts.map((context) => perfStatsDefines(context.environment))).toEqual([
			[],
			[],
			["-DMAL_PERF_STATS=1"],
		]);
		expect(ensureNativeArtifacts).toHaveBeenCalledWith(contexts.at(-1));
	});

	it.each(["arguments-forwarding.test.ts", "arguments-alias.test.ts"])(
		"prepares locked instrumentation before %s hooks",
		(file) => {
			setup(selectedProject(file));
			const locked = preparedContexts().filter(
				(context) => context.features?.primordialsLocked === true,
			);
			expect(locked).toHaveLength(1);
			expect(locked[0]?.features).toMatchObject({
				nodeEnabled: false,
				webPlatformEnabled: true,
			});
			expect(perfStatsDefines(locked[0]?.environment)).toEqual(["-DMAL_PERF_STATS=1"]);
			expect(ensureNativeArtifacts).toHaveBeenCalledWith(locked[0]);
		},
	);

	it.each([
		"gc.test.ts",
		"object-spread-shaped.test.ts",
		"profile.test.ts",
		"interpreter-dense-array.test.ts",
		"worker-pool-private-ref.test.ts",
		"worker-child-signals.test.ts",
	])("keeps %s outside default instrumented preparation", (file) => {
		setup(selectedProject(file));
		const contexts = preparedContexts();
		expect(contexts.map((context) => context.features?.nodeEnabled)).toEqual([
			false,
			true,
		]);
		expect(contexts.map((context) => perfStatsDefines(context.environment))).toEqual([
			[],
			[],
		]);
	});

	it("does not change the inherited runtime mode or worker allocation", () => {
		vi.stubEnv("MAL_UBSAN", "1");
		const inherited = { ...process.env };
		setup(selectedProject("map-get-set-cache.test.ts"));
		expect(process.env).toEqual(inherited);
		const [ordinary, node, instrumented] = preparedContexts();
		expect(ordinary!.environment).not.toBe(instrumented!.environment);
		expect(ordinary!.environment?.MAL_PERF_STATS).toBeUndefined();
		expect(instrumented!.environment?.MAL_PERF_STATS).toBe("1");
		for (const context of [ordinary!, node!, instrumented!]) {
			expect(context.environment?.MAL_UBSAN).toBe("1");
		}
	});

	it("retains inherited performance instrumentation without duplicate preparation", () => {
		vi.stubEnv("MAL_PERF_STATS", "1");
		setup(selectedProject("map-get-set-cache.test.ts"));
		const contexts = preparedContexts();
		expect(contexts.map((context) => context.features?.nodeEnabled)).toEqual([
			false,
			true,
		]);
		expect(contexts.map((context) => perfStatsDefines(context.environment))).toEqual([
			["-DMAL_PERF_STATS=1"],
			["-DMAL_PERF_STATS=1"],
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
