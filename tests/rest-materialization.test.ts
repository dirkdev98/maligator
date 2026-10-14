import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

function compile(body: string, closed = true, runtimeEval = false) {
	const source = `globalThis.run = ${body};`;
	const entry = "/rest-materialization.js";
	const base = compilerProgramFactsFromConfig(
		resolveBuildConfig({
			engine: { eval: runtimeEval, realms: false, primordials: "mutable" },
		}),
	);
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, entry),
		{
			facts: closed
				? withProgramClosure(
						base,
						programClosureCertificate({ kind: "whole-program", entry }, [], []),
					)
				: base,
			coreVerification: "per-pass",
		},
	);
	const index = image.runtime.functions.findIndex((fn) =>
		fn.instructions.some((op) => op.opcode === "CREATE_REST_ARGUMENTS"),
	);
	expect(index).toBeGreaterThanOrEqual(0);
	const fn = image.runtime.functions[index]!;
	return {
		image,
		index,
		fn,
		rest: fn.instructions.findIndex((op) => op.opcode === "CREATE_REST_ARGUMENTS"),
		branch: fn.instructions.findIndex((op) => op.opcode === "JUMP_IF"),
	};
}

describe("guarded captured rest materialization", () => {
	const guarded = `function run(...args) {
		if (!globalThis.gate.enabled) return false;
		globalThis.reader = () => args;
		return args;
	}`;
	it("materializes after the guard before publishing a captured binding", () => {
		const { rest, branch, fn } = compile(guarded);
		expect(branch).toBeGreaterThanOrEqual(0);
		expect(rest).toBeGreaterThan(branch);
		expect(
			fn.instructions.slice(0, rest).some((op) => op.opcode === "CREATE_FUNCTION"),
		).toBe(false);
	});
	it("keeps incoming arguments rooted across a collecting guard and releases that root after materialization", () => {
		const { image, index } = compile(guarded);
		const source = emitCompiledFunction(
			image.native.functions[index]!,
			index,
			"",
			false,
		)!.source;
		expect(source).toContain("mal_gc_root(&__argument_roots");
		expect(source).toContain("mal_gc_unroot(&__argument_roots)");
		expect(source).toContain("__argument_roots.count = 0");
	});
	it("does not add a deferred root lifetime to unconditional parameter initialization", () => {
		const { image, index } = compile(
			`function run(...args) { globalThis.reader = () => args; return args; }`,
		);
		expect(
			emitCompiledFunction(image.native.functions[index]!, index, "", false)!.source,
		).not.toContain("__argument_roots.count = 0");
	});
	it("retains incoming roots when arguments can still be read after the rest array changes", () => {
		const { image, index } = compile(`function run(...args) {
			if (!globalThis.gate.enabled) return false;
			globalThis.reader = () => args;
			args.length = 0;
			globalThis.collect();
			return arguments[0];
		}`);
		const source = emitCompiledFunction(
			image.native.functions[index]!,
			index,
			"",
			false,
		)!.source;
		expect(source).toContain("mal_gc_root(&__argument_roots");
		expect(source).not.toContain("__argument_roots.count = 0");
	});
	it("retains eager initialization across named parameter bindings", () => {
		const { rest, branch } = compile(`function run(first, ...args) {
			if (!globalThis.gate.enabled) return false;
			globalThis.reader = () => args;
			return args;
		}`);
		expect(rest).toBeLessThan(branch);
	});
	it("tracks transitive closure observers whose immediate parent never reads the binding", () => {
		const { rest, branch } = compile(`function run(...args) {
			if (!globalThis.gate.enabled) return false;
			globalThis.factory = () => () => args;
			return args;
		}`);
		expect(rest).toBeGreaterThan(branch);
	});
	it("allows unrelated per-iteration environments outside the binding's observer graph", () => {
		const { rest, branch } = compile(`(function () {
			for (let index = 0; index < 2; index++) globalThis.keep = () => index;
			return ${guarded};
		})()`);
		expect(rest).toBeGreaterThan(branch);
	});
	it.each([
		[
			"direct early observer",
			`globalThis.reader = () => args; if (!globalThis.gate.enabled) return false; return args;`,
		],
		[
			"transitive early observer",
			`globalThis.factory = () => () => args; if (!globalThis.gate.enabled) return false; return args;`,
		],
		[
			"early direct read",
			`globalThis.keep = args; if (!globalThis.gate.enabled) return false; globalThis.reader = () => args; return args;`,
		],
		[
			"another binding writer",
			`if (!globalThis.gate.enabled) return false; globalThis.keep = args; args = []; globalThis.reader = () => args; return args;`,
		],
		[
			"repeating destination",
			`while (globalThis.gate.enabled) { globalThis.reader = () => args; if (globalThis.gate.stop) break; } return args;`,
		],
		[
			"exception handler",
			`try { if (!globalThis.gate.enabled) return false; globalThis.reader = () => args; return args; } catch (error) { return args; }`,
		],
	])("retains eager initialization for %s", (_label, body) => {
		const { rest, branch } = compile(`function run(...args) { ${body} }`);
		expect(rest).toBeLessThan(branch);
	});
	it.each([
		{ closed: false, runtimeEval: false },
		{ closed: true, runtimeEval: true },
	])(
		"requires closed observers and disabled runtime eval: $closed/$runtimeEval",
		({ closed, runtimeEval }) => {
			const { rest, branch } = compile(guarded, closed, runtimeEval);
			expect(rest).toBeLessThan(branch);
		},
	);
	it("preserves the argument lifetime plan through the compiler artifact", () => {
		const { image, index } = compile(guarded);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(
			emitCompiledFunction(restored.native.functions[index]!, index, "", false)!.source,
		).toContain("__argument_roots.count = 0");
	});
});
