import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { emitProgramTranslationUnits } from "../src/compiler/target/emit-program-image.ts";
import { deserializeRuntimeImage } from "../src/compiler/target/program-image-codec.ts";

function temporaryDirectory(): string {
	return mkdtempSync(path.join(tmpdir(), "mal-build-frontend-cache-"));
}

function write(file: string, source: string): void {
	writeFileSync(file, source);
}

/** A project whose entry imports the CommonJS package `located`; returns the entry. */
function interpretedPackageProject(directory: string, packageSource: string): string {
	const packageDirectory = path.join(directory, "node_modules/located");
	mkdirSync(packageDirectory, { recursive: true });
	write(path.join(directory, "package.json"), `{"type":"module"}\n`);
	write(path.join(packageDirectory, "package.json"), `{"main":"./index.js"}\n`);
	write(path.join(packageDirectory, "index.js"), packageSource);
	const entrypoint = path.join(directory, "entry.mjs");
	write(entrypoint, `import located from "located";\nconsole.log(located);\n`);
	return entrypoint;
}

function compileInterpretedProject(entrypoint: string, cacheDirectory: string) {
	return compileBuildFrontend({
		entrypoint,
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "build-fragment-location-test",
		cacheDirectory,
		optimization: "development",
		relocatable: true,
		interpreted: true,
	});
}

function compile(
	entrypoint: string,
	cacheDirectory: string,
	session?: BuildCompilationSession,
) {
	return compileBuildFrontend({
		entrypoint,
		config: resolveBuildConfig({}),
		stripTypes: stripCompactTypes,
		stripperIdentity: "build-frontend-cache-test",
		cacheDirectory,
		session,
	});
}

describe("normal build frontend cache", () => {
	it("restores an AOT-equivalent definition without rebuilding the graph", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "answer.ts"), `export const answer: number = 42;\n`);
		write(entrypoint, `import { answer } from "./answer.ts";\nconsole.log(answer);\n`);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(warm.wire).toEqual(cold.wire);
		expect(emitProgramTranslationUnits(warm.programImage)).toEqual(
			emitProgramTranslationUnits(cold.programImage),
		);
		expect(warm.phases.graphMs).toBe(0);
		expect(warm.phases.semanticMs).toBe(0);
		expect(warm.phases.compileMs).toBe(0);
		expect(warm.runtimeArtifacts).toEqual(cold.runtimeArtifacts);
		expect(warm.imageStats).toEqual(cold.imageStats);
	});

	it("keeps optimizer instrumentation off in the normal cached build", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(entrypoint, `export const answer = 42;\n`);
		const compiled = compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory,
			forceCompile: true,
			profile: true,
		});

		expect(compiled.optimizationReport).toMatchObject({
			instrumentation: "off",
			phases: [],
			checkpoints: [],
			passes: [],
			analyses: [],
		});
		expect(compiled.optimizationPlan?.version.key).toMatch(/^p:/);
		expect(compiled.programImage.diagnostics).not.toHaveProperty(
			"coreOptimizationReport",
		);
		expect(compiled.programImage.diagnostics).not.toHaveProperty("coreOptimizationPlan");
	});

	it("collects full optimizer diagnostics only when requested", () => {
		const root = temporaryDirectory();
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(entrypoint, `export const answer = 42;\n`);
		const compiled = compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-instrumentation-test",
			cacheDirectory: path.join(root, "cache"),
			forceCompile: true,
			coreInstrumentation: "full",
		});

		expect(compiled.optimizationReport?.instrumentation).toBe("full");
		expect(compiled.optimizationReport?.phases.length).toBeGreaterThan(0);
		expect(compiled.optimizationReport?.passes.length).toBeGreaterThan(0);
	});

	it("does not turn instrumentation on for an optimization callback", () => {
		const root = temporaryDirectory();
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(entrypoint, `export const answer = 42;\n`);
		let instrumentation: string | undefined;
		compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-callback-test",
			cacheDirectory: path.join(root, "cache"),
			forceCompile: true,
			afterCoreOptimization(_program, _context, report) {
				instrumentation = report.instrumentation;
			},
		});

		expect(instrumentation).toBe("off");
	});

	it("separates cache entries by module aliases", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(path.join(root, "first.mjs"), `export const answer = 1;\n`);
		write(path.join(root, "second.mjs"), `export const answer = 2;\n`);
		write(entrypoint, `import { answer } from "answer";\nconsole.log(answer);\n`);
		const run = (target: string) =>
			compileBuildFrontend({
				entrypoint,
				config: resolveBuildConfig({
					modules: { aliases: { answer: target } },
				}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "build-frontend-cache-test",
				cacheDirectory,
			});

		expect(run("./first.mjs").cache).toBe("miss");
		expect(run("./first.mjs").cache).toBe("hit");
		expect(run("./second.mjs").cache).toBe("miss");
	});

	it("keeps a profiled compile out of the unprofiled cache entry", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function sum(values) {
				let total = 0;
				for (let i = 0; i < values.length; i++) total += values[i] * 2;
				return total;
			}
			console.log(sum(new Float64Array([1, 2, 3])));\n`,
		);
		// The CLI forces profiled compiles, which still publish where fragments do not apply.
		compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory,
			profile: true,
			forceCompile: true,
		});
		const plain = compile(entrypoint, cacheDirectory);
		expect(plain.cache).toBe("miss");
		expect(
			plain.programImage.native.functions.some(
				(fn) => (fn.storage?.numericLoopRegions.length ?? 0) > 0,
			),
		).toBe(true);
		expect(compile(entrypoint, cacheDirectory).programImage).toBeDefined();
	});

	it("stores and replays structured primordial diagnostics", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(entrypoint, `Math.extra = 1;\n`);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(cold.diagnostics).toHaveLength(1);
		expect(cold.diagnostics[0]?.code).toBe("primordial.mutation");
		expect(warm.diagnostics).toEqual(cold.diagnostics);
	});

	it("invalidates a changed wire identity before exposing a lazy artifact handle", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(entrypoint, `console.log(42);\n`);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		expect(warm.cache).toBe("hit");
		const artifact = warm.runtimeArtifacts[0]!;
		const times = statSync(artifact.path);
		writeFileSync(artifact.path, new Uint8Array(artifact.size));
		utimesSync(artifact.path, times.atime, times.mtime);

		const repaired = compile(entrypoint, cacheDirectory);
		expect(repaired.cache).toBe("miss");
		expect(repaired.wire).toEqual(cold.wire);
	});

	it("retains native numeric fusion across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			readFileSync(path.resolve("tests/local/literal-template.js"), "utf-8"),
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(emitProgramTranslationUnits(warm.programImage)).toEqual(
			emitProgramTranslationUnits(cold.programImage),
		);
	});

	it("retains String.split projection regions across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function project(value) {
				const fields = value.split(";");
				return fields[1] + fields[0] + fields.length;
			}
			globalThis.result = project("alpha;beta");\n`,
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		const coldRegions = cold.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "string-split-projection"),
		);
		const warmRegions = warm.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "string-split-projection"),
		);
		const coldC = emitProgramTranslationUnits(cold.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");
		const warmC = emitProgramTranslationUnits(warm.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(coldRegions).not.toHaveLength(0);
		expect(warmRegions).toEqual(coldRegions);
		expect(coldC).toContain("mal_builtin_string_split_projection");
		expect(warmC).toBe(coldC);
	});

	it("retains indexed-length loops inside exception handlers across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function frame(name, action) {
				try {
					return action();
				} catch (error) {
					return error.stack.split("\\n").find((text) => text.includes(name));
				}
			}
			globalThis.result = frame("at", () => { throw new Error("failed"); });\n`,
		);
		const compileLocked = () =>
			compileBuildFrontend({
				entrypoint,
				config: resolveBuildConfig({
					engine: { primordials: "locked", eval: false, realms: false },
				}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "build-frontend-cache-test",
				cacheDirectory,
			});
		const regions = (compiled: ReturnType<typeof compileLocked>) =>
			compiled.programImage.native.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "indexed-length-loop"),
			);

		const cold = compileLocked();
		const warm = compileLocked();

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(regions(cold)).not.toHaveLength(0);
		expect(regions(warm)).toEqual(regions(cold));
	});

	it("retains RegExp.exec projection regions across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				return Number(match[1]);
			}
			globalThis.result = parse(/([0-9]+)/, "42");\n`,
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		const coldRegions = cold.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "regexp-exec-projection"),
		);
		const warmRegions = warm.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "regexp-exec-projection"),
		);
		const coldC = emitProgramTranslationUnits(cold.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");
		const warmC = emitProgramTranslationUnits(warm.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(coldRegions).not.toHaveLength(0);
		expect(warmRegions).toEqual(coldRegions);
		expect(coldC).toContain("mal_regexp_exec_capture_projection");
		expect(warmC).toBe(coldC);
	});

	it("retains String.slice Number regions across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function parse(value) { return Number(value.slice(1)); }
			globalThis.result = parse("x42");\n`,
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		const coldRegions = cold.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "string-span"),
		);
		const warmRegions = warm.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "string-span"),
		);
		const coldC = emitProgramTranslationUnits(cold.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");
		const warmC = emitProgramTranslationUnits(warm.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(coldRegions).not.toHaveLength(0);
		expect(warmRegions).toEqual(coldRegions);
		expect(coldC).toContain("mal_builtin_string_range_span_init");
		expect(warmC).toBe(coldC);
	});

	it("retains RegExp iterator projection regions across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function total(value, regexp) {
				let sum = 0;
				for (const match of value.matchAll(regexp)) sum += Number(match[1]);
				return sum;
			}
			globalThis.result = total("1 2 3", /([0-9]+)/g);\n`,
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		const coldRegions = cold.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "regexp-iterator-projection"),
		);
		const warmRegions = warm.programImage.native.functions.flatMap((fn) =>
			fn.specializations.filter((region) => region.kind === "regexp-iterator-projection"),
		);
		const coldC = emitProgramTranslationUnits(cold.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");
		const warmC = emitProgramTranslationUnits(warm.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(coldRegions).not.toHaveLength(0);
		expect(warmRegions).toEqual(coldRegions);
		expect(coldC).toContain("mal_regexp_try_exact_iterator_capture_projection");
		expect(warmC).toBe(coldC);
	});

	it("retains fresh dense indexed-fill reserves across a frontend cache hit", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			entrypoint,
			`function fill() { const array = []; for (let i = 0; i < 1000; i++) array[i] = i; return array; }
			globalThis.result = fill().length;\n`,
		);

		const cold = compile(entrypoint, cacheDirectory);
		const warm = compile(entrypoint, cacheDirectory);
		const coldC = emitProgramTranslationUnits(cold.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");
		const warmC = emitProgramTranslationUnits(warm.programImage)
			.map((unit) => unit.sourceChunks.join(""))
			.join("\n");

		expect(cold.cache).toBe("miss");
		expect(warm.cache).toBe("hit");
		expect(coldC).toContain("mal_vm_try_fresh_dense_indexed_fill_reserve");
		expect(warmC).toBe(coldC);
	});

	it("invalidates changed sources and package-resolution inputs", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.ts");
		const dependency = path.join(root, "answer.ts");
		const packagePath = path.join(root, "package.json");
		write(packagePath, `{"type":"module"}\n`);
		write(dependency, `export const answer = 42;\n`);
		write(entrypoint, `import { answer } from "./answer.ts";\nvoid answer;\n`);

		expect(compile(entrypoint, cacheDirectory).cache).toBe("miss");
		expect(compile(entrypoint, cacheDirectory).cache).toBe("hit");

		write(dependency, `export const answer = 43;\n`);
		expect(compile(entrypoint, cacheDirectory).cache).toBe("miss");
		expect(compile(entrypoint, cacheDirectory).cache).toBe("hit");

		write(packagePath, `{"type":"module","private":true}\n`);
		expect(compile(entrypoint, cacheDirectory).cache).toBe("miss");
	});

	it("exposes explicit watcher invalidation on a retained filesystem session", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.ts");
		const dependency = path.join(root, "answer.ts");
		const session = new BuildCompilationSession();
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(dependency, `export const answer = 1;\n`);
		write(entrypoint, `import { answer } from "./answer.ts";\nvoid answer;\n`);

		expect(compile(entrypoint, cacheDirectory, session).cache).toBe("miss");
		write(dependency, readFileSync(dependency, "utf-8").replace("1", "2"));
		session.invalidate(dependency);

		expect(compile(entrypoint, cacheDirectory, session).cache).toBe("miss");
	});

	it("reuses unchanged module parses across forced edit compilations", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.ts");
		const dependency = path.join(root, "answer.ts");
		const session = new BuildCompilationSession();
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(dependency, `export const answer = 1;\n`);
		write(entrypoint, `import { answer } from "./answer.ts";\nvoid answer;\n`);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory,
			session,
			forceCompile: true,
			optimization: "development" as const,
		};

		expect(compileBuildFrontend(options).moduleParses).toEqual({ hits: 0, misses: 2 });
		expect(compileBuildFrontend(options).moduleParses).toEqual({ hits: 2, misses: 0 });

		write(dependency, `export const answer = 2;\n`);
		session.invalidate(dependency);
		expect(compileBuildFrontend(options).moduleParses).toEqual({ hits: 1, misses: 1 });
	});

	it("reuses module parses from an earlier command and still compiles their code", () => {
		const root = temporaryDirectory();
		const entrypoint = path.join(root, "entry.ts");
		const dependency = path.join(root, "answer.ts");
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(dependency, `export const answer = 41;\n`);
		write(
			entrypoint,
			`import { answer } from "./answer.ts";\nconsole.log(answer + 1);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory: path.join(root, "cache"),
			forceCompile: true,
			optimization: "development" as const,
		};

		const first = compileBuildFrontend(options);
		expect(first.moduleParses).toEqual({ hits: 0, misses: 2 });
		const reused = compileBuildFrontend(options);
		expect(reused.moduleParses).toEqual({ hits: 2, misses: 0 });
		expect(reused.wire).toEqual(first.wire);

		write(dependency, `export const answer = 1;\n`);
		const edited = compileBuildFrontend(options);
		expect(edited.moduleParses).toEqual({ hits: 1, misses: 1 });
		expect(edited.wire).not.toEqual(first.wire);
	});

	it("reuses a dependency base while recompiling an edited application fragment", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		const session = new BuildCompilationSession();
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(
			path.join(dependencyDirectory, "index.mjs"),
			`export let answer = 41;\nanswer++;\n`,
		);
		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log(answer, 0);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-cache-test",
			cacheDirectory,
			session,
			optimization: "development" as const,
			relocatable: true,
		};

		const cold = compileBuildFrontend(options);
		expect(cold.wires).toHaveLength(2);
		expect(cold.fragmentArtifacts).toEqual({ hits: 0, misses: 2 });

		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log(answer, 1);\n`,
		);
		session.invalidate(entrypoint);
		const changed = compileBuildFrontend(options);
		expect(changed.fragmentArtifacts).toEqual({ hits: 1, misses: 1 });
		expect(changed.wires).toHaveLength(2);
		expect(changed.wires![0]).toEqual(cold.wires![0]);
		expect(changed.wires![1]).not.toEqual(cold.wires![1]);

		write(
			path.join(dependencyDirectory, "index.mjs"),
			`export let answer = 42;\nanswer++;\n`,
		);
		session.invalidate(path.join(dependencyDirectory, "index.mjs"));
		const changedDependency = compileBuildFrontend(options);
		expect(changedDependency.fragmentArtifacts).toEqual({ hits: 1, misses: 1 });
		expect(changedDependency.wires![0]).not.toEqual(changed.wires![0]);
		expect(changedDependency.wires![1]).toEqual(changed.wires![1]);
	});

	it("keeps dependency fragments for an unforced build after a forced whole-image compile", () => {
		const root = temporaryDirectory();
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(
			path.join(dependencyDirectory, "index.mjs"),
			`export let answer = 41;\nanswer++;\n`,
		);
		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log(answer);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-cache-test",
			cacheDirectory: path.join(root, "cache"),
			optimization: "development" as const,
			relocatable: true,
		};

		const forced = compileBuildFrontend({ ...options, forceCompile: true });
		expect(forced.runtimeArtifacts).toHaveLength(1);
		const unforced = compileBuildFrontend(options);

		expect(unforced.runtimeArtifacts).toHaveLength(2);
		expect(unforced.fragmentArtifacts).toEqual({ hits: 0, misses: 2 });
	});

	it("reuses the Node prelude and fragment diagnostics across application edits", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		const dependency = path.join(dependencyDirectory, "index.mjs");
		const session = new BuildCompilationSession();
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(
			dependency,
			`Math.fragmentDependencyMutation = 1;\nexport const answer = "dependency-marker";\n`,
		);
		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log("application-marker-0", answer);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({ surface: { node: true } }),
			nodeGlobalsSource: `globalThis.__preludeMarker = "prelude-marker";\n`,
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-node-prelude-test",
			cacheDirectory,
			session,
			optimization: "development" as const,
			relocatable: true,
		};
		const strings = (wire: Uint8Array) =>
			deserializeRuntimeImage(wire).stringConstants.map((units) =>
				String.fromCharCode(...units),
			);

		const cold = compileBuildFrontend(options);
		expect(cold.wires).toHaveLength(3);
		expect(cold.fragmentArtifacts).toEqual({ hits: 0, misses: 3 });
		expect(strings(cold.wires![0]!)).toContain("prelude-marker");
		expect(strings(cold.wires![1]!)).toContain("dependency-marker");
		expect(strings(cold.wires![2]!)).toContain("application-marker-0");
		expect(cold.diagnostics.map(({ code }) => code)).toContain("primordial.mutation");

		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log("application-marker-1", answer);\n`,
		);
		session.invalidate(entrypoint);
		const changed = compileBuildFrontend(options);
		expect(changed.fragmentArtifacts).toEqual({ hits: 2, misses: 1 });
		expect(changed.wires![0]).toEqual(cold.wires![0]);
		expect(changed.wires![1]).toEqual(cold.wires![1]);
		expect(changed.wires![2]).not.toEqual(cold.wires![2]);
		expect(strings(changed.wires![2]!)).toContain("application-marker-1");
		expect(changed.diagnostics).toEqual(cold.diagnostics);
	});

	it("shares independent dependency islands across entrypoints and invalidates only one island", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const firstEntry = path.join(root, "first.mjs");
		const secondEntry = path.join(root, "second.mjs");
		const alphaDirectory = path.join(root, "node_modules/alpha");
		const betaDirectory = path.join(root, "node_modules/beta");
		const alpha = path.join(alphaDirectory, "index.mjs");
		const session = new BuildCompilationSession();
		mkdirSync(alphaDirectory, { recursive: true });
		mkdirSync(betaDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(alphaDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(
			path.join(betaDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(alpha, `export const alpha = 1;\n`);
		write(path.join(betaDirectory, "index.mjs"), `export const beta = 2;\n`);
		write(
			firstEntry,
			`import { alpha } from "alpha";\nimport { beta } from "beta";\nconsole.log(alpha, beta);\n`,
		);
		write(secondEntry, `import { beta } from "beta";\nconsole.log(beta);\n`);
		const options = (entrypoint: string) => ({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-island-test",
			cacheDirectory,
			session,
			optimization: "development" as const,
			relocatable: true,
			dependencyWorker: {
				tool: process.execPath,
				args: [path.resolve("src/index.ts")],
			},
		});

		const combined = compileBuildFrontend(options(firstEntry));
		expect(combined.wires).toHaveLength(3);
		expect(combined.fragmentArtifacts).toEqual({ hits: 0, misses: 3 });

		const betaOnly = compileBuildFrontend(options(secondEntry));
		expect(betaOnly.wires).toHaveLength(2);
		expect(betaOnly.fragmentArtifacts).toEqual({ hits: 1, misses: 1 });
		expect(betaOnly.wires![0]).toEqual(combined.wires![1]);

		write(alpha, `export const alpha = 3;\n`);
		session.invalidate(alpha);
		const changedAlpha = compileBuildFrontend(options(firstEntry));
		expect(changedAlpha.fragmentArtifacts).toEqual({ hits: 2, misses: 1 });
		expect(changedAlpha.wires![0]).not.toEqual(combined.wires![0]);
		expect(changedAlpha.wires![1]).toEqual(combined.wires![1]);
		expect(changedAlpha.wires![2]).toEqual(combined.wires![2]);
	}, 30_000);

	it("recompiles the application only when a dependency's exported names change", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const local = path.join(root, "local.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		const dependency = path.join(dependencyDirectory, "index.mjs");
		const session = new BuildCompilationSession();
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(dependency, `export const answer = 42;\n`);
		write(local, `export const revision = 0;\n`);
		write(
			entrypoint,
			`import { answer } from "example-dependency";\nimport { revision } from "./local.mjs";\nconsole.log(answer, revision);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-linkage-test",
			cacheDirectory,
			session,
			optimization: "development" as const,
			relocatable: true,
		};
		const rebuild = (file: string, source: string) => {
			write(file, source);
			session.invalidate(file);
			return compileBuildFrontend(options).fragmentArtifacts;
		};

		expect(compileBuildFrontend(options).fragmentArtifacts).toEqual({
			hits: 0,
			misses: 2,
		});
		expect(rebuild(local, `export const revision = 1;\n`)).toEqual({
			hits: 1,
			misses: 1,
		});
		expect(rebuild(dependency, `export const answer = 43;\n`)).toEqual({
			hits: 1,
			misses: 1,
		});
		expect(
			rebuild(dependency, `export const answer = 43;\nexport const added = true;\n`),
		).toEqual({ hits: 0, misses: 2 });
	});

	it("links namespace imports across the dependency boundary", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(path.join(dependencyDirectory, "index.mjs"), `export const answer = 42;\n`);
		write(
			entrypoint,
			`import * as dependency from "example-dependency";\nvoid dependency.answer;\n`,
		);

		const compiled = compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-fallback-test",
			cacheDirectory,
			optimization: "development",
			relocatable: true,
		});

		expect(compiled.fragmentFallback).toBeUndefined();
		expect(compiled.wires).toHaveLength(2);
	});

	it("keeps interpreted images free of native plans and out of native builds", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(path.join(dependencyDirectory, "index.mjs"), `export const answer = 42;\n`);
		write(
			entrypoint,
			`import { answer } from "example-dependency";\nconsole.log(answer);\n`,
		);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-interpreted-test",
			cacheDirectory,
			optimization: "development" as const,
			relocatable: true,
		};
		const compilerArtifacts = path.join(cacheDirectory, "frontend/compiler-artifacts");

		const interpreted = compileBuildFrontend({ ...options, interpreted: true });
		expect(interpreted.fragmentArtifacts).toEqual({ hits: 0, misses: 3 });
		expect(existsSync(compilerArtifacts)).toBe(false);
		expect(compileBuildFrontend({ ...options, interpreted: true }).cache).toBe("hit");

		const native = compileBuildFrontend(options);
		expect(native.fragmentArtifacts).toEqual({ hits: 0, misses: 2 });
		expect(native.fragmentCompilerArtifacts).toHaveLength(2);
		expect(native.programImage.native.functions.length).toBeGreaterThan(0);
	});

	it("reuses an interpreted dependency image at another project location", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const first = interpretedPackageProject(
			path.join(root, "first"),
			`module.exports = { dirname: __dirname };\n`,
		);
		const second = interpretedPackageProject(
			path.join(root, "second-location"),
			`module.exports = { dirname: __dirname };\n`,
		);

		const compiledFirst = compileInterpretedProject(first, cacheDirectory);
		const compiledSecond = compileInterpretedProject(second, cacheDirectory);

		expect(compiledFirst.fragmentArtifacts).toEqual({ hits: 0, misses: 3 });
		expect(compiledSecond.fragmentArtifacts).toEqual({ hits: 1, misses: 2 });
		const [packageRoot, island] = compiledSecond.wires!.map(deserializeRuntimeImage);
		const secondModules = path.join(path.dirname(second), "node_modules");
		expect(packageRoot!.moduleLinks!.exports.map((link) => link.module)).toEqual([
			path.join(secondModules, ".maligator-package-root.mjs"),
			path.join(secondModules, ".maligator-package-root.mjs"),
		]);
		for (const link of [
			...island!.moduleLinks!.imports,
			...island!.moduleLinks!.exports,
		]) {
			expect(link.module.startsWith(`${secondModules}${path.sep}`)).toBe(true);
		}
	});

	it("keeps a dependency image that names its own location to that location", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const locatedSource = (project: string) =>
			`module.exports = ${JSON.stringify(path.join(project, "node_modules"))};\n`;
		const first = interpretedPackageProject(
			path.join(root, "first"),
			locatedSource(path.join(root, "first")),
		);
		const second = interpretedPackageProject(
			path.join(root, "second"),
			locatedSource(path.join(root, "first")),
		);

		compileInterpretedProject(first, cacheDirectory);
		expect(compileInterpretedProject(second, cacheDirectory).fragmentArtifacts).toEqual({
			hits: 0,
			misses: 3,
		});
		write(first, `import located from "located";\nconsole.log(located, 1);\n`);
		expect(compileInterpretedProject(first, cacheDirectory).fragmentArtifacts).toEqual({
			hits: 2,
			misses: 1,
		});
	});

	it("links a dependency export that a dependency function reassigns", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.mjs");
		const dependencyDirectory = path.join(root, "node_modules/example-dependency");
		mkdirSync(dependencyDirectory, { recursive: true });
		write(path.join(root, "package.json"), `{"type":"module"}\n`);
		write(
			path.join(dependencyDirectory, "package.json"),
			`{"type":"module","exports":"./index.mjs"}\n`,
		);
		write(
			path.join(dependencyDirectory, "index.mjs"),
			`export let answer = 42;\nexport function update() { answer++; }\n`,
		);
		write(
			entrypoint,
			`import { answer, update } from "example-dependency";\nupdate();\nconsole.log(answer);\n`,
		);

		const compiled = compileBuildFrontend({
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-fragment-live-binding-test",
			cacheDirectory,
			optimization: "development",
			relocatable: true,
			dependencyWorker: {
				tool: process.execPath,
				args: [path.resolve("src/index.ts")],
			},
		});

		expect(compiled.fragmentFallback).toBeUndefined();
		expect(compiled.wires).toHaveLength(2);
	}, 30_000);

	it("does not reuse policy-unchecked portable output for a checked native build", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(entrypoint, `eval("1");\n`);
		const options = {
			entrypoint,
			config: resolveBuildConfig({ engine: { eval: "compile-check" } }),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory,
		};

		expect(compileBuildFrontend({ ...options, enforcePolicies: false }).cache).toBe(
			"miss",
		);
		expect(() => compileBuildFrontend(options)).toThrow(/dynamic code is rejected/);
	});

	it("does not mix development and full optimization artifacts", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(entrypoint, `console.log(40 + 2);\n`);
		const options = {
			entrypoint,
			config: resolveBuildConfig({}),
			stripTypes: stripCompactTypes,
			stripperIdentity: "build-frontend-cache-test",
			cacheDirectory,
		};

		expect(compileBuildFrontend({ ...options, optimization: "development" }).cache).toBe(
			"miss",
		);
		expect(compileBuildFrontend({ ...options, optimization: "development" }).cache).toBe(
			"hit",
		);
		expect(compileBuildFrontend({ ...options, optimization: "full" }).cache).toBe("miss");
		expect(compileBuildFrontend({ ...options, optimization: "development" }).cache).toBe(
			"hit",
		);
	});
});
