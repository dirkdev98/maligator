import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDerivationFromConfig, resolveBuildConfig } from "../../src/build-config.ts";
import { runSemanticAnalysisForGraph } from "../../src/compiler/frontend/analyze-module-graph.ts";
import { buildModuleGraph } from "../../src/compiler/frontend/module-graph.ts";
import type { ExternalModuleInterface } from "../../src/compiler/frontend/module-graph.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { serializeRuntimeImage } from "../../src/compiler/target/program-image-codec.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";
const fixture = "tests/local/node-source-builtin.mjs",
	outDir = mkdtempSync(join(tmpdir(), "mal-source-builtin-")),
	env = { MAL_BUILTIN_ID: "node:test" };
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("computed source builtin loading", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-source-builtin",
			outDir,
			config: resolveBuildConfig({
				engine: {
					primordials: "mutable",
					eval: false,
					realms: false,
					intl: { enabled: false },
					temporal: false,
				},
			}),
		});
	});
	it.each(["builtin", "require", "import"])(
		"shares exports after loading first through %s",
		(order) => {
			const environment = { ...env, MAL_BUILTIN_ORDER: order };
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...environment },
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of sanitized ? [{}] : [{}, STRESS_ENV])
					expect(runToStdout(binary, { env: { ...environment, ...stress } })).toBe(
						expected,
					);
		},
	);
});

describe("source builtin image ownership", () => {
	const config = resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: false,
			realms: false,
			intl: { enabled: false },
			temporal: false,
		},
	});
	let runner: string;
	beforeAll(() => {
		const derivation = buildDerivationFromConfig(config);
		runner = buildDevelopmentRunner(
			resolveNativeBuildContext({ features: derivation.features }),
			false,
			derivation.cacheSuffix,
		).binaryPath;
	});
	function image(
		name: string,
		source: string,
		externalModules = new Map<string, ExternalModuleInterface>(),
	) {
		const entry = join(outDir, `${name}.mjs`);
		const graph = buildModuleGraph(entry, {
			entrySource: source,
			entryGoal: "module",
			stripTypes: (source) => source,
			buildConfig: config,
			externalModules,
		});
		const program = compileSemanticProgramToProgramImage(
			runSemanticAnalysisForGraph(graph),
			{ optimization: "development", semanticLowering: { moduleExports: "all" } },
		);
		const wire = join(outDir, `${name}.malw`);
		writeFileSync(wire, serializeRuntimeImage(program.runtime));
		return {
			wire,
			interfaces: new Map(
				(program.moduleInterfaces ?? []).map(({ module, ...surface }) => [
					module,
					surface,
				]),
			),
		};
	}
	it.each(["padding", "computed", "retained", "literal"])(
		"shares module state after splicing a %s owner",
		(order) => {
			writeFileSync(
				join(outDir, "source-trigger.mjs"),
				`if (globalThis.loadTest) globalThis.firstTest = globalThis.loadTest("node:test");`,
			);
			const first = image(
				`source-first-${order}`,
				order === "padding"
					? `globalThis.padding = "nonzero relocation";`
					: order === "computed"
						? `globalThis.firstTest = process.getBuiltinModule("node:test");`
						: order === "retained"
							? `globalThis.loadTest = id => process.getBuiltinModule(id);`
							: `import * as ns from "node:test"; globalThis.firstTest = ns.default; globalThis.firstNamespace = ns;`,
			);
			const second = image(
				`source-second-${order}`,
				`
			import "./source-trigger.mjs";
			import test, {test as named} from "node:test";
			const id = process.env.MAL_BUILTIN_ID;
			const ns = await import(id);
			const identities = [test === named, ns.default === test, process.getBuiltinModule(id) === test, !globalThis.firstTest || globalThis.firstTest === test, !globalThis.firstNamespace || globalThis.firstNamespace === ns];
			if (identities.some(value => !value)) throw new Error("source builtin identity " + JSON.stringify(identities));
			let ran = false;
			await test("spliced source state", () => {ran = true;});
			if (!ran) throw new Error("source builtin private state");
			console.log("SOURCE BUILTIN LINK PASS");
		`,
				new Map([
					...first.interfaces,
					["node:test", { goal: "module", exports: ["default", "test"] }],
				]),
			);
			const invocation = resolveHarnessExecutionInvocation(runner);
			for (const stress of [{}, STRESS_ENV]) {
				const output = execFileSync(
					invocation.executable,
					[
						...invocation.args,
						"--maligator-internal-run-wires",
						"2",
						second.wire,
						first.wire,
						second.wire,
					],
					{
						encoding: "utf8",
						env: { ...process.env, ...env, ...stress, MAL_GC_AT_EXIT: "1" },
						timeout: 30000,
					},
				);
				expect(output).toContain("SOURCE BUILTIN LINK PASS\n");
			}
		},
	);
});

describe("source builtin loader realm", () => {
	it("keeps a borrowed getBuiltinModule in its callee realm", () => {
		const fixture = "tests/local/node-source-builtin-realm.mjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-source-builtin-realm",
			outDir,
			config: resolveBuildConfig({
				engine: {
					primordials: "mutable",
					eval: true,
					realms: true,
				},
			}),
		});
		const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		);
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of sanitized ? [{}] : [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
});

describe("CommonJS source builtin loading", () => {
	it("shares a computed wrapper require with the builtin registry", () => {
		const fixture = "tests/local/node-source-builtin.cjs";
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-source-builtin-cjs",
			outDir,
			config: resolveBuildConfig({
				engine: {
					primordials: "mutable",
					eval: false,
					realms: false,
					intl: { enabled: false },
					temporal: false,
				},
			}),
		});
		const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
			(key) => process.env[key] === "1",
		);
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of sanitized ? [{}] : [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
});
