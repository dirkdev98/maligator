import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import { parseCliArgs } from "../src/cli.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import {
	CORE_CONSTRUCTION_ANNOTATION_PASSES,
	CORE_CONSTRUCTION_NORMALIZATION_PASSES,
	CORE_LOCAL_CANONICALIZATION_PASSES,
} from "../src/compiler/core/core-local-passes.ts";
import { CoreFunctionPassScheduler } from "../src/compiler/core/core-pass-manager.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { conservativeCompilerProgramFacts } from "../src/compiler/shared/compiler-facts.ts";
import { loadOrCompileCoreModule } from "../src/core-module-cache.ts";

const directories: Array<string> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

it.each(["unchanged", "before", "annotation"] as const)(
	"rechecks construction cleanup only after imported body edits: %s",
	(edit) => {
		const { root, options } = fixture();
		const lib = path.join(root, "lib.mjs");
		const reused = loadOrCompileCoreModule({
			source: readFileSync(lib, "utf8"),
			sourcePath: lib,
			moduleKey: "lib",
			cacheDirectory: path.join(root, "module-cache"),
		});
		if (reused.status !== "ready") throw new Error(reused.reason);
		const semantic = runSemanticAnalysisForGraph(
			buildModuleGraph(options.entrypoint, {
				entryGoal: "module",
				stripTypes: (source) => source,
			}),
		);
		const compilation = lowerSemanticProgramToCore(semantic, {
			facts: conservativeCompilerProgramFacts(),
			reusableModule: (sourcePath) =>
				sourcePath === lib
					? { artifact: reused.optimized, completedRecipe: reused.completedRecipe }
					: undefined,
		});
		const imported = new Set(compilation.reusedFunctions!.keys());
		const target = [...compilation.program.functionIds()].find((id) => imported.has(id))!;
		const mutate = () => {
			const editor = CoreEditor.open(compilation.program, target);
			editor.appendInstruction(editor.function.entry, "createNumber", [], {
				attributes: { value: 12345 },
			});
			return editor.commit();
		};
		if (edit === "before") mutate();
		const annotation = CORE_CONSTRUCTION_ANNOTATION_PASSES[0]!;
		const annotate = annotation.run.bind(annotation);
		let injected = false;
		vi.spyOn(annotation, "run").mockImplementation((context) => {
			if (edit === "annotation" && context.item.function === target && !injected) {
				injected = true;
				return mutate();
			}
			return annotate(context);
		});
		// eslint-disable-next-line @typescript-eslint/unbound-method -- The spy forwards each scheduler receiver.
		const run = CoreFunctionPassScheduler.prototype.runComponent;
		const runComponent = vi.spyOn(CoreFunctionPassScheduler.prototype, "runComponent");
		const normalized = new Set<number>();
		const primary = new Set<number>();
		runComponent.mockImplementation(function (this: CoreFunctionPassScheduler, ...args) {
			const observed =
				args[1] === CORE_CONSTRUCTION_NORMALIZATION_PASSES
					? normalized
					: args[1] === CORE_LOCAL_CANONICALIZATION_PASSES
						? primary
						: undefined;
			if (observed === undefined) return run.apply(this, args);
			return run.call(
				this,
				args[0],
				args[1].map((pass) => ({
					...pass,
					run(context) {
						observed.add(context.item.function);
						return pass.run(context);
					},
				})),
				args[2],
				args[3],
			);
		});
		optimizeCore(compilation, { verification: "per-pass" });
		expect(normalized.has(target)).toBe(edit !== "unchanged");
		expect(injected).toBe(edit === "annotation");
		for (const id of imported) if (id !== target) expect(normalized.has(id)).toBe(false);
		for (const id of imported) expect(primary.has(id)).toBe(true);
	},
);
function fixture() {
	const root = mkdtempSync(path.join(tmpdir(), "core-module-build-"));
	directories.push(root);
	const write = (file: string, source: string) =>
		writeFileSync(path.join(root, file), source);
	write("package.json", '{"type":"module"}');
	write(
		"lib.mjs",
		"let n = 1; const scale = x => x * 2; export function bump() { n = scale(n) + 1; } export { n }; export function counter(start) { return () => ++start; }",
	);
	write("first.mjs", "import { bump } from './lib.mjs'; bump();");
	write("second.mjs", "import { n } from './lib.mjs'; export const snapshot = n;");
	write(
		"entry.mjs",
		"import './first.mjs'; import { snapshot } from './second.mjs'; import * as lib from './lib.mjs'; console.log(snapshot, lib.n, lib.counter(7)());",
	);
	const options = {
		entrypoint: path.join(root, "entry.mjs"),
		cacheDirectory: path.join(root, "cache"),
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "core-module-build-test",
		coreModuleCache: true,
		coreVerification: "per-pass" as const,
		coreInstrumentation: "counters" as const,
	};
	return { root, write, options };
}

it("reuses dependency Core after an application edit while retaining private source facts", () => {
	const { write, options } = fixture();
	const cold = compileBuildFrontend(options);
	expect(cold.coreModules).toMatchObject({ misses: 1, hits: 0, unsupported: 0 });
	expect(cold.coreModules!.constructedFunctions).toBeGreaterThan(1);
	const sameSourceWarm = compileBuildFrontend({ ...options, forceCompile: true });
	expect(sameSourceWarm.wire).toEqual(cold.wire);
	write(
		"entry.mjs",
		"import './first.mjs'; import { snapshot } from './second.mjs'; import * as lib from './lib.mjs'; function added(x) { return x + 2; } console.log('changed', added(snapshot), lib.n, lib.counter(9)());",
	);
	let privateCandidates = 0;
	const warm = compileBuildFrontend({
		...options,
		afterCoreOptimization(_program, context) {
			privateCandidates = context.data.singleAssignmentGlobalSlots.length;
		},
	});
	expect(warm.cache).toBe("miss");
	expect(warm.coreModules).toMatchObject({
		hits: 1,
		misses: 0,
		constructedFunctions: 0,
		optimizedFunctions: 0,
	});
	expect(privateCandidates).toBeGreaterThan(1);
	const repeat = compileBuildFrontend({ ...options, forceCompile: true });
	expect(repeat.wire).toEqual(warm.wire);
});

it("invalidates changed dependency bodies and resolved module instances", () => {
	const { write, options } = fixture();
	compileBuildFrontend(options);
	write(
		"lib.mjs",
		"export let n = 11; export function bump() { n++; } export function counter(start) { return () => ++start; }",
	);
	expect(compileBuildFrontend(options).coreModules).toMatchObject({ hits: 0, misses: 1 });
	write(
		"other.mjs",
		"export let n = 11; export function bump() { n++; } export function counter(start) { return () => ++start; }",
	);
	write(
		"entry.mjs",
		"import './first.mjs'; import { snapshot } from './second.mjs'; import * as lib from './other.mjs'; console.log(snapshot, lib.n);",
	);
	expect(compileBuildFrontend(options).coreModules).toMatchObject({ hits: 1, misses: 1 });
});

it("reuses already parsed TypeScript and invalidates a changed stripping producer", () => {
	const { write, options } = fixture();
	write("typed.ts", "export const n: number = 4;");
	write("entry.mjs", "import { n } from './typed.ts'; console.log(n);");
	expect(compileBuildFrontend(options).coreModules).toMatchObject({ misses: 1 });
	write("entry.mjs", "import { n } from './typed.ts'; console.log(n + 1);");
	expect(compileBuildFrontend(options).coreModules).toMatchObject({
		hits: 1,
		constructedFunctions: 0,
	});
	expect(
		compileBuildFrontend({ ...options, stripperIdentity: "changed-stripper" })
			.coreModules,
	).toMatchObject({ hits: 0, misses: 1 });
});

it("remembers unsupported boundaries instead of reconstructing them after each app edit", () => {
	const { write, options } = fixture();
	write(
		"lib.mjs",
		"export const n = Math; export function bump() {} export function counter() { for (let i = 0; i < 2; i++) (() => i)(); return () => 1; }",
	);
	const cold = compileBuildFrontend(options);
	expect(cold.coreModules).toMatchObject({ unsupported: 1 });
	expect(cold.coreModules!.constructedFunctions).toBeGreaterThan(0);
	write("entry.mjs", "import { n } from './lib.mjs'; console.log(n === Math);");
	expect(compileBuildFrontend(options).coreModules).toMatchObject({
		unsupported: 1,
		constructedFunctions: 0,
		optimizedFunctions: 0,
	});
});

it("declines dynamic graphs before probing dependency Core", () => {
	const { write, options } = fixture();
	write(
		"entry.mjs",
		"import { n } from './lib.mjs'; console.log(n); import('./second.mjs');",
	);
	const reused = compileBuildFrontend(options).coreModules;
	expect(reused).toMatchObject({
		hits: 0,
		misses: 0,
		constructedFunctions: 0,
	});
	expect(reused?.fallback).toContain("static ESM");
});

it("requires an explicit production build for the experimental CLI path", () => {
	expect(
		parseCliArgs(["build", "entry.mjs", "--production", "--core-cache"]),
	).toMatchObject({ coreCache: true, production: true });
	for (const args of [
		["build", "--core-cache"],
		["build", "--production", "--core-cache", "--pgo-train"],
		["build", "--production", "--core-cache", "--profile"],
	])
		expect(() => parseCliArgs(args)).toThrow();
});
