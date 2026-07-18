import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "../src/semantic-program.ts";

const nodeOn = resolveBuildConfig({ surface: { node: true } });
const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture(files: Record<string, string>) {
	const root = mkdtempSync(path.join(tmpdir(), "maligator-cjs-loader-"));
	roots.push(root);
	for (const [relativePath, source] of Object.entries(files)) {
		const filePath = path.join(root, relativePath);
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, source);
	}
	return root;
}

function strings(constants: Array<Array<number>>): Set<string> {
	return new Set(constants.map((constant) => String.fromCharCode(...constant)));
}

describe("CommonJS loader lowering", () => {
	it("shares canonical host identity and retains one stable exports object", () => {
		const root = fixture({
			"main.cjs": `const bare = require("path");\nconst canonical = require("node:path");\nglobalThis.sink = [bare, canonical];\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"), {
			buildConfig: nodeOn,
		});
		const dependencies = program.graph!.modules.get(program.entrypointPath)!.dependencies;

		expect(dependencies.map((dependency) => dependency.resolvedPath)).toEqual([
			"node:path",
			"node:path",
		]);
		expect(
			[...program.graph!.modules.keys()].filter((id) => id === "node:path"),
		).toHaveLength(1);

		const definition = compileSemanticProgramToVmDefinition(program);
		expect(definition.hostInstalls).toEqual([
			expect.objectContaining({
				installer: "mal_host_install_node_path",
				exports: [expect.objectContaining({ name: "default" })],
			}),
		]);
	});

	it("assigns one wrapper per file across JSON and CommonJS cycles", () => {
		const root = fixture({
			"main.cjs": `globalThis.sink = [require("./a.cjs"), require("./data.json")];\n`,
			"a.cjs": `exports.name = "a";\nexports.b = require("./b.cjs");\n`,
			"b.cjs": `exports.a = require("./a.cjs");\n`,
			"data.json": `{"answer":42}\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"));
		const definition = compileSemanticProgramToVmDefinition(program);

		expect(definition.cjsModuleFunctionIndices).toHaveLength(4);
		expect(new Set(definition.cjsModuleFunctionIndices).size).toBe(4);
		for (const functionIndex of definition.cjsModuleFunctionIndices) {
			expect(definition.functions[functionIndex]!.instructions.length).toBeGreaterThan(2);
		}
		expect(program.graph!.cycles).toHaveLength(1);
		expect(new Set(program.graph!.cycles[0]!.map((file) => path.basename(file)))).toEqual(
			new Set(["a.cjs", "b.cjs"]),
		);
	});

	it("bakes each wrapper's absolute filename and dirname", () => {
		const root = fixture({
			"main.cjs": `globalThis.sink = [__filename, __dirname, require("./child.cjs")];\n`,
			"child.cjs": `module.exports = [__filename, __dirname];\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"));
		const definition = compileSemanticProgramToVmDefinition(program);
		const constants = strings(definition.stringConstants);

		expect(constants).toContain(path.join(root, "main.cjs"));
		expect(constants).toContain(path.join(root, "child.cjs"));
		expect(constants).toContain(root);
	});

	it("lowers require of a synchronous ES module to one stable namespace", () => {
		const root = fixture({
			"main.cjs": `const a = require("./dep.mjs");\nconst b = require("./dep.mjs");\nglobalThis.sink = [a, b];\n`,
			"dep.mjs": `export const named = 1;\nexport default 2;\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"));
		const definition = compileSemanticProgramToVmDefinition(program);

		expect(
			definition.functions
				.flatMap((fn) => fn.instructions)
				.filter((instruction) => instruction.opcode === "CREATE_MODULE_NAMESPACE"),
		).toHaveLength(1);
		expect(definition.cjsModuleFunctionIndices).toHaveLength(1);
	});

	it("rejects top-level await in a synchronously required ES module graph", () => {
		const root = fixture({
			"main.cjs": `require("./dep.mjs");\n`,
			"dep.mjs": `await 0;\nexport default 1;\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"));

		expect(() => compileSemanticProgramToVmDefinition(program)).toThrow(
			/CommonJS cannot synchronously require an ES module graph with top-level await/,
		);
	});

	it("rejects cycles involving a synchronously required ES module", () => {
		const root = fixture({
			"main.cjs": `module.exports = require("./dep.mjs");\n`,
			"dep.mjs": `import main from "./main.cjs";\nexport default main;\n`,
		});
		const program = loadEntrypointAndRunSemanticAnalysis(path.join(root, "main.cjs"));

		expect(() => compileSemanticProgramToVmDefinition(program)).toThrow(
			/CommonJS cannot synchronously require a cyclic ES module graph/,
		);
	});
});
