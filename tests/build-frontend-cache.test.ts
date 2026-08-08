import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

		expect(
			compileBuildFrontend({ ...options, optimization: "development" }).cache,
		).toBe("miss");
		expect(
			compileBuildFrontend({ ...options, optimization: "development" }).cache,
		).toBe("hit");
		expect(compileBuildFrontend({ ...options, optimization: "full" }).cache).toBe(
			"miss",
		);
	});
});
