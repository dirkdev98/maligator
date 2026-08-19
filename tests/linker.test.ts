import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { linkModules } from "../src/compiler/frontend/linker.ts";
import type {
	Binding,
	SemanticFile,
	SemanticProgram,
} from "../src/compiler/frontend/semantic-analysis.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-program.ts";

/** A resolved config with the node host surface enabled. */
const nodeOn = resolveBuildConfig({ surface: { node: true } });

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-link-"));
	roots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const full = path.join(root, relativePath);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, contents);
	}
	return root;
}

const fileFor = (program: SemanticProgram, absolutePath: string): SemanticFile =>
	program.files.find((file) => file.path === absolutePath)!;

function topBinding(file: SemanticFile, name: string): Binding {
	const binding = file.scopes[0]!.bindings.find(
		(candidate) => candidate.name === name && !candidate.undeclared,
	);
	if (!binding) {
		throw new Error(`no top-level binding '${name}' in ${file.path}`);
	}
	return binding;
}

test("aliases imported names to the exporting module's binding (shared storage)", () => {
	const root = tree({
		"a.mjs": `export function f() {\n\treturn 7;\n}\nexport const k = 9;\n`,
		"main.mjs": `import { f, k } from "./a.mjs";\nglobalThis.sink = [f(), k];\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const mainFile = fileFor(program, path.join(root, "main.mjs"));
	const aFile = fileFor(program, path.join(root, "a.mjs"));

	// Capture the import bindings' usage nodes before linking consumes them.
	const fUsages = [...topBinding(mainFile, "f").usageNodes];
	const kUsages = [...topBinding(mainFile, "k").usageNodes];
	const exportedF = topBinding(aFile, "f");
	const exportedK = topBinding(aFile, "k");

	linkModules(program);

	expect(fUsages.length).toBeGreaterThan(0);
	for (const node of fUsages) {
		expect(mainFile.nodeToBinding.get(node)).toBe(exportedF);
	}
	for (const node of kUsages) {
		expect(mainFile.nodeToBinding.get(node)).toBe(exportedK);
	}
});

test("follows a named re-export to the original binding", () => {
	const root = tree({
		"a.mjs": `export function f() {\n\treturn 7;\n}\n`,
		"b.mjs": `export { f } from "./a.mjs";\n`,
		"main.mjs": `import { f as g } from "./b.mjs";\nglobalThis.sink = g();\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const mainFile = fileFor(program, path.join(root, "main.mjs"));
	const aFile = fileFor(program, path.join(root, "a.mjs"));

	const gUsages = [...topBinding(mainFile, "g").usageNodes];
	const exportedF = topBinding(aFile, "f");

	linkModules(program);

	expect(gUsages.length).toBeGreaterThan(0);
	for (const node of gUsages) {
		expect(mainFile.nodeToBinding.get(node)).toBe(exportedF);
	}
});

test("throws on an import the target module does not export", () => {
	const root = tree({
		"a.mjs": `export const x = 1;\n`,
		"main.mjs": `import { nope } from "./a.mjs";\nglobalThis.sink = nope;\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	expect(() => linkModules(program)).toThrow(/does not export 'nope'/);
});

test("throws for an invalid indirect re-export even when it is not imported", () => {
	const root = tree({
		"a.mjs": `export const x = 1;\n`,
		"main.mjs": `export { nope } from "./a.mjs";\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	expect(() => linkModules(program)).toThrow(SyntaxError);
	expect(() => linkModules(program)).toThrow(/does not export 'nope'/);
});

test("rejects conflicting export-star names but de-duplicates the same binding", () => {
	const ambiguousRoot = tree({
		"a.mjs": `export const x = 1;\n`,
		"b.mjs": `export const x = 2;\n`,
		"barrel.mjs": `export * from "./a.mjs";\nexport * from "./b.mjs";\n`,
		"main.mjs": `import { x } from "./barrel.mjs";\nglobalThis.sink = x;\n`,
	});
	const ambiguous = loadEntrypointAndRunSemanticAnalysis(
		path.join(ambiguousRoot, "main.mjs"),
	);
	expect(() => linkModules(ambiguous)).toThrow(/ambiguous import 'x'/);

	const sharedRoot = tree({
		"a.mjs": `export const x = 1;\n`,
		"b.mjs": `export { x } from "./a.mjs";\n`,
		"barrel.mjs": `export * from "./a.mjs";\nexport * from "./b.mjs";\n`,
		"main.mjs": `import { x } from "./barrel.mjs";\nglobalThis.sink = x;\n`,
	});
	const shared = loadEntrypointAndRunSemanticAnalysis(path.join(sharedRoot, "main.mjs"));
	expect(() => linkModules(shared)).not.toThrow();
});

test("treats namespace re-exports of the same module as unambiguous", () => {
	const root = tree({
		"empty.mjs": `export {};\n`,
		"a.mjs": `import * as foo from "./empty.mjs";\nexport { foo };\n`,
		"b.mjs": `import * as foo from "./empty.mjs";\nexport { foo };\n`,
		"barrel.mjs": `export * from "./a.mjs";\nexport * from "./b.mjs";\n`,
		"main.mjs": `import { foo } from "./barrel.mjs";\nglobalThis.sink = foo;\n`,
	});
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	expect(() => linkModules(program)).not.toThrow();
});

test("resolves a namespace import to the module's (sorted) exports", () => {
	const root = tree({
		"a.mjs": `export const y = 2;\nexport const x = 1;\nexport default 9;\n`,
		"main.mjs": `import * as ns from "./a.mjs";\nglobalThis.sink = ns;\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);

	const nsImports = linkage.namespaceImports.get(path.join(root, "main.mjs"));
	expect(nsImports).toHaveLength(1);
	expect(nsImports?.[0]?.exports.map((entry) => entry.name)).toEqual([
		"default",
		"x",
		"y",
	]);
});

test("records ESM imports from a CommonJS module instead of aliasing them", () => {
	const root = tree({
		"lib.cjs": `exports.greet = "hi";\nmodule.exports.extra = 7;\n`,
		"main.mjs": `import lib, { greet } from "./lib.cjs";\nglobalThis.sink = [lib, greet];\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);

	const cjsImports = linkage.cjsImports.get(path.join(root, "main.mjs"));
	expect(cjsImports).toHaveLength(2);
	expect(cjsImports?.map((entry) => ({ kind: entry.kind, name: entry.name }))).toEqual([
		{ kind: "default", name: undefined },
		{ kind: "named", name: "greet" },
	]);
	// All resolve to the one CommonJS module.
	expect(new Set(cjsImports?.map((entry) => entry.cjsPath))).toEqual(
		new Set([path.join(root, "lib.cjs")]),
	);
});

test("follows CommonJS whole-module re-exports when building namespaces", () => {
	const root = tree({
		"entry.cjs": `if (process.env.MODE) {\n\tmodule.exports = require("./a.cjs");\n} else {\n\tmodule.exports = require("./b.cjs");\n}\n`,
		"a.cjs": `exports.forwardRef = function () {};\n`,
		"b.cjs": `exports.createElement = function () {};\n`,
		"main.mjs": `import * as ns from "./entry.cjs";\nglobalThis.sink = ns;\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);

	expect(linkage.cjsImports.get(path.join(root, "main.mjs"))?.[0]).toMatchObject({
		kind: "namespace",
		names: ["createElement", "forwardRef"],
	});
});

test("re-exporting from a CommonJS module records cjs imports for it", () => {
	const root = tree({
		"lib.cjs": `exports.x = 1;\nexports.y = 2;\n`,
		"main.mjs": `export { x as ex } from "./lib.cjs";\nexport * from "./lib.cjs";\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);

	// A synthetic cjs import per re-exported name: `x` (renamed via `as ex`) plus
	// the two detected names from `export *` (x, y).
	const cjsImports = linkage.cjsImports.get(path.join(root, "main.mjs"));
	expect(cjsImports?.length).toBe(3);
	expect(cjsImports?.every((entry) => entry.cjsPath === path.join(root, "lib.cjs"))).toBe(
		true,
	);
	expect(cjsImports?.map((entry) => entry.name).sort()).toEqual(["x", "x", "y"]);
});

test("records export-star-as namespaces for ESM and CommonJS sources", () => {
	const root = tree({
		"esm.mjs": `export const x = 1;\n`,
		"lib.cjs": `exports.z = 2;\nexports.a = 1;\n`,
		"main.mjs": `export * as esm from "./esm.mjs";\nexport * as cjs from "./lib.cjs";\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);
	const mainPath = path.join(root, "main.mjs");

	expect(
		linkage.namespaceImports
			.get(mainPath)
			?.map((entry) => entry.exports.map((item) => item.name)),
	).toEqual([["x"]]);
	expect(
		linkage.cjsImports.get(mainPath)?.map((entry) => ({
			kind: entry.kind,
			names: entry.names,
		})),
	).toEqual([{ kind: "namespace", names: ["a", "z"] }]);
	expect(linkage.moduleNamespaces.get(mainPath)?.map((entry) => entry.name)).toEqual([
		"cjs",
		"esm",
	]);
});

test("aliases host built-in imports to synthetic global bindings and records them", () => {
	const root = tree({
		"main.mjs": `import { join } from "node:path";\nimport { hash } from "node:crypto";\nglobalThis.sink = [join, hash];\n`,
	});

	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	const mainFile = fileFor(program, path.join(root, "main.mjs"));
	const joinUsages = [...topBinding(mainFile, "join").usageNodes];

	const linkage = linkModules(program);

	const pathModule = linkage.hostModules.find((m) => m.specifier === "node:path");
	expect(pathModule?.installer).toBe("mal_host_install_node_path");
	const joinBinding = pathModule?.exports.find((e) => e.name === "join")?.binding;
	expect(joinBinding).toBeDefined();
	// The importer's `join` reads alias to the one synthetic host binding (shared
	// storage → a single LOAD_GLOBAL slot).
	expect(joinUsages.length).toBeGreaterThan(0);
	for (const node of joinUsages) {
		expect(mainFile.nodeToBinding.get(node)).toBe(joinBinding);
	}
	// Every reached built-in is registered, path carries its default export.
	expect(new Set(linkage.hostModules.map((m) => m.specifier))).toEqual(
		new Set(["node:path", "node:crypto"]),
	);
	expect(pathModule?.exports.some((e) => e.name === "default")).toBe(true);
});

test("throws on an import a host built-in does not export", () => {
	const root = tree({
		"main.mjs": `import { nope } from "node:path";\nglobalThis.sink = nope;\n`,
	});
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	expect(() => linkModules(program)).toThrow(/node:path does not export 'nope'/);
});

test("resolves a namespace import of a host built-in to its (sorted) exports", () => {
	const root = tree({
		"main.mjs": `import * as p from "node:path";\nglobalThis.sink = p;\n`,
	});
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	const linkage = linkModules(program);
	const nsImports = linkage.namespaceImports.get(path.join(root, "main.mjs"));
	expect(nsImports?.[0]?.exports.map((e) => e.name)).toEqual([
		"basename",
		"default",
		"delimiter",
		"dirname",
		"extname",
		"isAbsolute",
		"join",
		"normalize",
		"posix",
		"relative",
		"resolve",
		"sep",
	]);
});

test("detects a free global `process` without rebinding its references", () => {
	const root = tree({
		"main.mjs": `globalThis.sink = process.argv;\nif (typeof process !== "undefined") {\n\tglobalThis.other = process;\n}\n`,
	});
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	const mainFile = fileFor(program, path.join(root, "main.mjs"));
	const undeclared = mainFile.scopes[0]!.bindings.find(
		(b) => b.name === "process" && b.undeclared,
	)!;
	const usages = [...undeclared.usageNodes];

	const linkage = linkModules(program);

	expect(linkage.hostProcess?.installer).toBe("mal_host_install_process");
	// Reads (including `typeof`) remain on the undeclared binding so they resolve
	// through the same global object property as globalThis.process.
	expect(usages.length).toBeGreaterThan(0);
	for (const node of usages) {
		expect(mainFile.nodeToBinding.get(node)).toBe(undeclared);
	}
});

test("detects assignment to a free global `process` under the node surface", () => {
	const root = tree({ "main.mjs": `process = globalThis.replacement;\n` });
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	expect(linkModules(program).hostProcess?.installer).toBe("mal_host_install_process");
});

test("does not treat `process` as a host global without the node surface", () => {
	const root = tree({
		"main.mjs": `globalThis.sink = process.argv;\n`,
	});
	// Default config: node surface off.
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"));
	const linkage = linkModules(program);
	expect(linkage.hostProcess).toBeUndefined();
});

test("does not treat a locally-declared `process` as the host global", () => {
	const root = tree({
		"main.mjs": `const process = { argv: [] };\nglobalThis.sink = process.argv;\n`,
	});
	const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.mjs"), {
		buildConfig: nodeOn,
	});
	const linkage = linkModules(program);
	// `process` resolves to the top-level const, never an undeclared global.
	expect(linkage.hostProcess).toBeUndefined();
});
