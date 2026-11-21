import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import type { CompileBuildFrontendOptions } from "../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An ESM project with one dependency package, so it always compiles linked images. */
function project(files: Record<string, string>) {
	const root = mkdtempSync(path.join(tmpdir(), "mal-application-images-"));
	roots.push(root);
	const write = (name: string, source: string) => {
		const file = path.join(root, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, source);
		return file;
	};
	write("package.json", `{"type":"module"}\n`);
	write("node_modules/answer/package.json", `{"type":"module","exports":"./index.js"}\n`);
	write("node_modules/answer/index.js", "export const answer = 42;\n");
	for (const [name, source] of Object.entries(files)) write(name, source);
	return {
		write,
		pruneDependencyReferences: () =>
			rmSync(path.join(root, "cache", "dependency-fragments", "artifacts"), {
				recursive: true,
				force: true,
			}),
		compile: (
			overrides: Partial<
				Pick<CompileBuildFrontendOptions, "session" | "config" | "stripperIdentity">
			> = {},
		) =>
			compileBuildFrontend({
				entrypoint: path.join(root, "entry.mjs"),
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "application-images-test",
				cacheDirectory: path.join(root, "cache"),
				optimization: "development",
				relocatable: true,
				interpreted: true,
				...overrides,
			}),
	};
}

const layered = {
	"entry.mjs": `import { answer } from "answer";\nimport { label } from "./label.mjs";\nconsole.log(label(answer));\n`,
	"label.mjs": `import { prefix } from "./prefix.mjs";\nexport const label = (value) => prefix + value;\n`,
	"prefix.mjs": `export const prefix = "answer ";\n`,
};

describe("interpreted application images", () => {
	it("recompiles only an edited module whose exported names stay the same", () => {
		const { write, compile } = project(layered);
		expect(compile().fragmentArtifacts?.misses).toBeGreaterThan(1);

		write("prefix.mjs", `export const prefix = "the answer ";\n`);
		const edited = compile();

		const dependencyImages =
			project({
				"entry.mjs": `import { answer } from "answer";\nconsole.log(answer);\n`,
			}).compile().runtimeArtifacts.length - 1;
		// The dependency's images, `label.mjs`'s and the entry's are reused.
		expect(edited.fragmentArtifacts).toEqual({ hits: dependencyImages + 2, misses: 1 });
	});

	it("reuses resolved dependency images across sessions on a project-only edit", () => {
		const { write, compile, pruneDependencyReferences } = project(layered);
		compile();
		pruneDependencyReferences();

		write("prefix.mjs", `export const prefix = "the answer ";\n`);

		expect(compile().fragmentArtifacts?.misses).toBe(1);
	});

	it("republishes a missing dependency artifact before loading the image set", () => {
		const { compile } = project(layered);
		const original = compile();
		const wires = original.wires;
		rmSync(original.runtimeArtifacts[0]!.path);

		const rebuilt = compile();

		expect(rebuilt.fragmentArtifacts?.misses).toBe(1);
		expect(rebuilt.wires).toEqual(wires);
	});

	it("refreshes the dependency images after a path in node_modules is invalidated", () => {
		const { write, compile, pruneDependencyReferences } = project(layered);
		const session = new FrontendCompilationSession();
		compile({ session });
		pruneDependencyReferences();

		session.invalidate(write("node_modules/answer/README.txt", "Package update\n"));
		session.invalidate(write("prefix.mjs", `export const prefix = "the answer ";\n`));

		expect(compile({ session }).fragmentArtifacts?.misses).toBeGreaterThan(1);
	});

	it("refreshes the dependency images when a lockfile changes between sessions", () => {
		const { write, compile, pruneDependencyReferences } = project(layered);
		write("package-lock.json", `{"lockfileVersion":3}\n`);
		compile();
		pruneDependencyReferences();

		write("package-lock.json", `{"lockfileVersion":3,"packages":{}}\n`);
		write("prefix.mjs", `export const prefix = "the answer ";\n`);

		expect(compile().fragmentArtifacts?.misses).toBeGreaterThan(1);
	});

	it("recompiles a dependency whose package export redirects to an already loaded module", () => {
		const packageExports = (target: string) =>
			JSON.stringify({
				type: "module",
				exports: { ".": "./index.js", "./choice": target },
			});
		const { write, compile } = project({
			...layered,
			"node_modules/answer/package.json": packageExports("./first.js"),
			"node_modules/answer/index.js": `
				import "./first.js";
				import "./second.js";
				export { answer } from "answer/choice";
			`,
			"node_modules/answer/first.js": "export const answer = 41;\n",
			"node_modules/answer/second.js": "export const answer = 42;\n",
		});
		const first = compile();

		write("node_modules/answer/package.json", packageExports("./second.js"));
		const second = compile();

		expect(second.fragmentArtifacts?.misses).toBe(1);
		expect(second.runtimeArtifacts.map(({ digest }) => digest)).not.toEqual(
			first.runtimeArtifacts.map(({ digest }) => digest),
		);
	});

	it("refreshes the dependency images after the build configuration changes", () => {
		const { write, compile, pruneDependencyReferences } = project(layered);
		const session = new FrontendCompilationSession();
		compile({ session });
		pruneDependencyReferences();

		session.invalidate(write("prefix.mjs", `export const prefix = "the answer ";\n`));

		const rebuilt = compile({
			session,
			config: resolveBuildConfig({ outputName: "different" }),
		});
		expect(rebuilt.fragmentArtifacts?.misses).toBeGreaterThan(1);
	});

	it("refreshes the dependency images after the frontend toolchain identity changes", () => {
		const { compile } = project(layered);
		const session = new FrontendCompilationSession();
		compile({ session });

		const rebuilt = compile({ session, stripperIdentity: "next-stripper" });

		expect(rebuilt.fragmentArtifacts?.hits).toBe(0);
	});

	it("recompiles the importers of a module whose exported names change", () => {
		const { write, compile } = project(layered);
		compile();

		write("prefix.mjs", `export const prefix = "answer ";\nexport const suffix = "!";\n`);

		// The edited module and `label.mjs`, which imports it; the entry imports only `label`.
		expect(compile().fragmentArtifacts?.misses).toBe(2);
	});

	it("keeps modules joined by import() in one application image", () => {
		const split = project(layered).compile();
		const joined = project({
			...layered,
			"label.mjs": `export const label = (value) => "answer " + value;\nexport const load = () => import("./prefix.mjs");\n`,
		}).compile();

		expect(joined.fragmentFallback).toBeUndefined();
		expect(joined.runtimeArtifacts.length).toBeLessThan(split.runtimeArtifacts.length);
		expect(joined.fragmentArtifacts?.misses).toBe(joined.runtimeArtifacts.length);
	});

	it("compiles the modules from the first top-level await on as one image", () => {
		const files = {
			"entry.mjs": `import "./before.mjs";\nimport "./suspends.mjs";\nimport "./after.mjs";\n`,
			"before.mjs": `console.log("before");\n`,
			"suspends.mjs": `await null;\nconsole.log("suspends");\n`,
			"after.mjs": `console.log("after");\n`,
		};
		const synchronous = project({
			...files,
			"suspends.mjs": `console.log("suspends");\n`,
		}).compile();
		const suspending = project(files).compile();

		// `suspends`, `after` and the entry share one image; `before` keeps its own.
		expect(synchronous.runtimeArtifacts.length - suspending.runtimeArtifacts.length).toBe(
			2,
		);
	});

	it("groups the modules of a large application into fewer images that an edit recompiles one at a time", () => {
		const modules = 160;
		const chain = (index: number, revision: number) =>
			index === 0
				? `export const value0 = ${revision};\n`
				: `import { value${index - 1} } from "./m${index - 1}.mjs";\nexport const value${index} = value${index - 1} + 1;\n`;
		const { write, compile } = project({
			...Object.fromEntries(
				Array.from({ length: modules }, (_, index) => [`m${index}.mjs`, chain(index, 0)]),
			),
			"entry.mjs": `import { value${modules - 1} } from "./m${modules - 1}.mjs";\nconsole.log(value${modules - 1});\n`,
		});
		const cold = compile();
		expect(cold.runtimeArtifacts.length).toBeLessThan(modules / 2);

		write("m0.mjs", chain(0, 1));

		expect(compile().fragmentArtifacts?.misses).toBe(1);
	});
});
