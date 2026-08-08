import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../src/build-frontend-cache.ts";
import { emitVmTranslationUnits } from "../src/emit-vm.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

function temporaryDirectory(): string {
	return mkdtempSync(path.join(tmpdir(), "mal-build-frontend-cache-"));
}

function write(file: string, source: string): void {
	writeFileSync(file, source);
}

function compile(
	entrypoint: string,
	cacheDirectory: string,
	session?: BuildCompilationSession,
) {
	return compileBuildFrontend({
		entrypoint,
		config: resolveBuildConfig({}),
		stripTypes: stripTypesWithTypeScript,
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
		expect(warm.definition).toEqual(cold.definition);
		expect(warm.wire).toEqual(cold.wire);
		expect(emitVmTranslationUnits(warm.definition)).toEqual(
			emitVmTranslationUnits(cold.definition),
		);
		expect(warm.phases.graphMs).toBe(0);
		expect(warm.phases.semanticMs).toBe(0);
		expect(warm.phases.compileMs).toBe(0);
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
		expect(emitVmTranslationUnits(warm.definition)).toEqual(
			emitVmTranslationUnits(cold.definition),
		);
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
			stripTypes: stripTypesWithTypeScript,
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
			stripTypes: stripTypesWithTypeScript,
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

	it("falls back to a whole image for namespace imports across the boundary", () => {
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
			stripTypes: stripTypesWithTypeScript,
			stripperIdentity: "build-fragment-fallback-test",
			cacheDirectory,
			optimization: "development",
			relocatable: true,
		});

		expect(compiled.wires).toBeUndefined();
		expect(compiled.fragmentFallback).toContain("namespace import");
	});

	it("falls back when a dependency export has a live mutable binding", () => {
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
			stripTypes: stripTypesWithTypeScript,
			stripperIdentity: "build-fragment-live-binding-test",
			cacheDirectory,
			optimization: "development",
			relocatable: true,
		});

		expect(compiled.wires).toBeUndefined();
		expect(compiled.fragmentFallback).toContain("live export 'answer'");
	});

	it("does not reuse policy-unchecked portable output for a checked native build", () => {
		const root = temporaryDirectory();
		const cacheDirectory = path.join(root, "cache");
		const entrypoint = path.join(root, "entry.js");
		write(entrypoint, `eval("1");\n`);
		const options = {
			entrypoint,
			config: resolveBuildConfig({ engine: { eval: "compile-check" } }),
			stripTypes: stripTypesWithTypeScript,
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
			stripTypes: stripTypesWithTypeScript,
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
