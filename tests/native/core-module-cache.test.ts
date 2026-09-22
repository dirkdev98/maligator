import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { compileBuildFrontend } from "../../src/build-frontend-cache.ts";
import { CoreAnalysisManager } from "../../src/compiler/core/core-analysis-manager.ts";
import { CoreFunctionBuilder } from "../../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../../src/compiler/core/core-ir-opcodes.ts";
import { buildCoreOptimizationPlan } from "../../src/compiler/core/core-ir-region-selection.ts";
import { verifyCoreOptimizationPlan } from "../../src/compiler/core/core-ir-region-validity.ts";
import type { CoreValueId } from "../../src/compiler/core/core-ir.ts";
import { importCoreModule } from "../../src/compiler/core/core-module-artifact.ts";
import { CoreOptimizationReportBuilder } from "../../src/compiler/core/core-optimization-report.ts";
import { CORE_PROGRAM_SUMMARIES_ANALYSIS } from "../../src/compiler/core/core-program-flow-analysis.ts";
import { CoreProgram } from "../../src/compiler/core/core-store.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { lowerCoreCompilationToExecution } from "../../src/compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../../src/compiler/target/lower-native-program-image.ts";
import { loadOrCompileCoreModule } from "../../src/core-module-cache.ts";
import { buildNativeProgramImage } from "../../src/test-harness.ts";
import { programAnalysisContext } from "../helpers/core-program-analysis.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "core-module-native-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("executes relocated cold and warm modules with independent private state", () => {
	const options = {
		source:
			"let n = 1; export function add(x) { n += x + (2 * 3); return n; } export function read() { return n; }",
		sourcePath: "/first/pilot.mjs",
		moduleKey: "pilot",
		cacheDirectory: directory,
	};
	const cold = loadOrCompileCoreModule(options);
	const warm = loadOrCompileCoreModule({
		...options,
		sourcePath: "/second/pilot.mjs",
		onWork() {
			throw new Error("Unexpected warm work");
		},
	});
	if (cold.status !== "ready" || warm.status !== "ready")
		throw new Error("Pilot did not compile");
	const program = new CoreProgram(coreOpcodeRegistry, {
		globalCount: 5,
		stringConstants: [
			[99],
			[..."console"].map((c) => c.charCodeAt(0)),
			[..."log"].map((c) => c.charCodeAt(0)),
		],
		sourcePositions: [{ line: 90, column: 1 }],
	});
	const driver = new CoreFunctionBuilder(program);
	const entry = driver.createBlock();
	const modules = [cold.canonical, cold.optimized, warm.optimized].map((artifact) =>
		importCoreModule(program, artifact, "/relocated/pilot.mjs"),
	);
	const undef = driver.appendInstruction(entry, "createUndefined", [])[0]!;
	const number = (value: number) =>
		driver.appendInstruction(entry, "createNumber", [], { attributes: { value } })[0]!;
	const call = (callee: CoreValueId, args: Array<CoreValueId> = []) =>
		driver.appendInstruction(entry, "call", [callee, undef, ...args])[0]!;
	for (const module of modules)
		call(
			driver.appendInstruction(entry, "createFunction", [], {
				attributes: { functionIndex: module.initializer },
			})[0]!,
		);
	const exportCall = (
		imported: (typeof modules)[number],
		name: string,
		args: Array<CoreValueId> = [],
	) =>
		call(
			driver.appendInstruction(entry, "loadGlobal", [], {
				attributes: { index: imported.exports.get(name)! },
			})[0]!,
			args,
		);
	const results = modules.map((module) => exportCall(module, "add", [number(2)]));
	exportCall(modules[0]!, "add", [number(10)]);
	results.push(...modules.map((module) => exportCall(module, "read")));
	const console = driver.appendInstruction(entry, "loadGlobalProperty", [], {
		attributes: { nameStringIndex: 1 },
	})[0]!;
	const log = driver.appendInstruction(entry, "loadPropertyStatic", [console], {
		attributes: { stringIndex: 2 },
	})[0]!;
	driver.appendInstruction(entry, "call", [log, console, ...results]);
	driver.setTerminator(entry, { kind: "return", value: undef });
	driver.finish(entry);
	const context = programAnalysisContext(false);
	const analyses = new CoreAnalysisManager(
		program,
		context,
		new CoreOptimizationReportBuilder(program),
	);
	const summaries = analyses.get(CORE_PROGRAM_SUMMARIES_ANALYSIS, { scope: "program" });
	const plan = buildCoreOptimizationPlan(
		program,
		analyses,
		summaries,
		[...program.functionIds()],
		{ context, discoverCandidates: false },
	);
	const sealed = program.seal();
	const verified = verifyCoreOptimizationPlan(sealed, plan, context);
	const image = lowerExecutionToProgramImage(
		lowerCoreCompilationToExecution({ program: sealed, context, plan: verified }),
	);
	const binary = buildNativeProgramImage(image, {
		name: "relocated-core",
		outDir: directory,
		compiled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
		webPlatformEnabled: false,
	});
	const result = spawnSync(binary, [], { encoding: "utf8" });
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("9 9 9 25 9 9");
}, 120_000);

it("reuses Meriyah after an application edit with relocated pools and identical parser behavior", () => {
	const write = (file: string, source: string) =>
		writeFileSync(path.join(directory, file), source);
	write(
		"meriyah.mjs",
		readFileSync(path.resolve("node_modules/meriyah/dist/meriyah.mjs"), "utf8"),
	);
	write(
		"values.mjs",
		`
		export let effects = 0;
		export function literal() { return [1,2,3,4,5,6,7,8,9,10,11,12,13,,"leaf",123n,{ key: -0 }]; }
		export class Box extends Error { constructor() { super('box'); this.items = literal(); } get size() { return this.items.length; } }
		export function choose(key, callback) {
			try { try { switch (key) { case 'a': return callback(1); case 'a': return 91; case 'b': return callback(2); default: return 3; } }
			catch (error) { return key + error; } } finally { effects++; }
		}
	`,
	);
	const entry = `
		import { parseScript, parseModule, isParseError } from './meriyah.mjs';
		import { literal, Box, choose, effects } from './values.mjs';
		const box = new Box(), other = new Box(); box.items[0] = 99;
		console.log(box instanceof Error, box.message, box.size, other.items[0], String(literal()[15]), 13 in literal(), 1 / literal()[16].key);
		console.log(choose('a', x => x + 4), choose('b', x => { throw x; }), choose('z', () => 9), effects);
		const comments = [], tokens = [];
		const first = parseScript('// hello\\nconst café = "雪"; /a+/u;', { loc: true, ranges: true, onComment: comments, onToken: tokens });
		console.log(JSON.stringify(first), comments.length, tokens.length);
		console.log(JSON.stringify(parseModule('export class A { #x = 1; async f() { return this.#x; } }', { next: true, lexical: true })));
		try { parseScript('const ='); } catch (error) { console.log(isParseError(error), error.name, error.message, JSON.stringify(error.start), JSON.stringify(error.end)); }
		try { parseScript('/(/'); } catch (error) { console.log(isParseError(error), error.name); }
		console.log(parseScript('/(/', { validateRegex: false }).body[0].expression.value);
		try { parseScript('// throw\\n1;', { onComment() { throw 'callback'; } }); } catch (error) { console.log(error); }
		first.body.length = 0;
		console.log(parseScript('const café = "雪";').body.length);
		const NativeRegExp = RegExp;
		let calls = 0;
		globalThis.RegExp = function(pattern, flags) { calls++; return new NativeRegExp(pattern, flags); };
		console.log(parseScript('/ab+/u').body[0].expression.value.source, calls);
		globalThis.RegExp = NativeRegExp;
	`;
	write("parser-entry.mjs", entry);
	const node = spawnSync(process.execPath, [path.join(directory, "parser-entry.mjs")], {
		encoding: "utf8",
	});
	expect(node.status).toBe(0);
	const options = {
		entrypoint: path.join(directory, "parser-entry.mjs"),
		cacheDirectory: path.join(directory, "meriyah-cache"),
		config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		stripTypes: stripCompactTypes,
		stripperIdentity: "native-meriyah-core-module",
		coreModuleCache: true,
	};
	const execute = (
		image: ReturnType<typeof compileBuildFrontend>["programImage"],
		name: string,
		compiled = true,
	) => {
		const binary = buildNativeProgramImage(image, {
			name,
			outDir: directory,
			compiled,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: true,
			webPlatformEnabled: false,
		});
		const result = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(node.stdout);
	};
	const ordinary = compileBuildFrontend({ ...options, coreModuleCache: false });
	execute(ordinary.programImage, "meriyah-ordinary");
	const cold = compileBuildFrontend(options);
	expect(cold.coreModules).toMatchObject({ misses: 2, hits: 0, unsupported: 0 });
	expect(cold.coreModules!.constructedFunctions).toBeGreaterThan(200);
	execute(cold.programImage, "meriyah-cold");
	write(
		"parser-prefix.mjs",
		`
		async function outsideBoundary() {}
		function literal() { return [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,"prefix",99n]; }
		const first = literal(); first[0] = 50;
		if (literal()[0] !== 1 || first[16] !== 99n) throw 'bad prefix';
	`,
	);
	write("parser-entry.mjs", `import './parser-prefix.mjs';\n${entry}`);
	const warm = compileBuildFrontend(options);
	expect(warm.coreModules).toMatchObject({
		hits: 2,
		misses: 0,
		constructedFunctions: 0,
		optimizedFunctions: 0,
	});
	execute(warm.programImage, "meriyah-warm");
	execute(warm.programImage, "meriyah-warm-vm", false);
}, 120_000);

it("stops application initialization when a cached dependency throws", () => {
	writeFileSync(path.join(directory, "throwing.mjs"), "throw 27;");
	writeFileSync(
		path.join(directory, "after-throw.mjs"),
		"import './throwing.mjs'; console.log('must not run');",
	);
	const options = {
		entrypoint: path.join(directory, "after-throw.mjs"),
		cacheDirectory: path.join(directory, "throw-cache"),
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "native-core-module",
		coreModuleCache: true,
	};
	compileBuildFrontend(options);
	const warm = compileBuildFrontend({ ...options, forceCompile: true });
	expect(warm.coreModules).toMatchObject({ hits: 1, constructedFunctions: 0 });
	const binary = buildNativeProgramImage(warm.programImage, {
		name: "throwing-cached-module",
		outDir: directory,
		compiled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
		webPlatformEnabled: false,
	});
	const result = spawnSync(binary, [], { encoding: "utf8" });
	expect(result.status).not.toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("27");
}, 120_000);

it("preserves initialization, live exports and independent closures across ordinary dependency cache hits", () => {
	const write = (file: string, source: string) =>
		writeFileSync(path.join(directory, file), source);
	const source =
		"export let n = 1; export { n as default }; const twice = x => x * 2; export function bump() { n = twice(n) + 1; } export function counter(start) { return () => ++start; } export function nested(start) { return () => () => ++start; }";
	write("lib.mjs", source);
	write("other.mjs", source);
	write("first.mjs", "import { bump } from './lib.mjs'; bump();");
	write(
		"second.mjs",
		"import { n } from './lib.mjs'; export const snapshot = n; export { default as live } from './lib.mjs';",
	);
	const entry =
		"import './first.mjs'; import { snapshot, live } from './second.mjs'; import * as lib from './lib.mjs'; import * as other from './other.mjs'; const a = lib.counter(1), b = lib.counter(10), deep = lib.nested(30)() ; console.log(snapshot, live, lib.n, other.n, a(), b(), a(), deep(), deep()); lib.bump(); console.log(live, lib.n, other.n);";
	write("entry.mjs", entry);
	const options = {
		entrypoint: path.join(directory, "entry.mjs"),
		cacheDirectory: path.join(directory, "build-cache"),
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "native-core-module",
		coreVerification: "per-pass" as const,
		coreModuleCache: true,
	};
	const execute = (
		image: ReturnType<typeof compileBuildFrontend>["programImage"],
		name: string,
		compiled = true,
	) => {
		const binary = buildNativeProgramImage(image, {
			name,
			outDir: directory,
			compiled,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			regexpEnabled: false,
			webPlatformEnabled: false,
		});
		const result = spawnSync(binary, [], { encoding: "utf8" });
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		return result.stdout.trim();
	};
	const expected = "3 3 3 1 2 11 3 31 32\n7 7 1";
	const ordinary = compileBuildFrontend({ ...options, coreModuleCache: false });
	expect(execute(ordinary.programImage, "ordinary-modules")).toBe(expected);
	const cold = compileBuildFrontend(options);
	expect(cold.coreModules).toMatchObject({ hits: 0, misses: 2, unsupported: 0 });
	expect(execute(cold.programImage, "cold-modules")).toBe(expected);
	write(
		"prefix.mjs",
		"async function unused() {} const marker = {}; function earlier(x) { return () => x + 1; } marker.f = earlier(4); if (marker.f() !== 5) throw 91;",
	);
	write("entry.mjs", `import './prefix.mjs';\n${entry}`);
	const warm = compileBuildFrontend(options);
	expect(warm.coreModules).toMatchObject({
		hits: 2,
		misses: 0,
		constructedFunctions: 0,
		optimizedFunctions: 0,
	});
	expect(execute(warm.programImage, "warm-modules")).toBe(expected);
	expect(execute(warm.programImage, "warm-modules-vm", false)).toBe(expected);
	write("lib.mjs", source.replace("n = 1", "n = 2"));
	const changed = compileBuildFrontend(options);
	expect(changed.coreModules).toMatchObject({ hits: 1, misses: 1 });
	expect(execute(changed.programImage, "changed-modules")).toBe(
		"5 5 5 1 2 11 3 31 32\n11 11 1",
	);
}, 120_000);
