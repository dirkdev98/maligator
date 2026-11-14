import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { MaligatorBuildConfig } from "../src/build-config.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	coreBlocks,
	coreFunctionNamed,
	coreOperations,
} from "./helpers/core-inspection.ts";

function compile(expression: string, engine: MaligatorBuildConfig["engine"] = {}) {
	const sourcePath = "flat-singleton.mjs";
	const source = `function normalize(input) { return ${expression}; }
		globalThis.result = normalize(globalThis.input);`;
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({ engine })),
				programClosureCertificate({ kind: "whole-program", entry: sourcePath }, [], []),
			),
			coreVerification: "per-pass",
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);
	return coreFunctionNamed(optimized!, "normalize")!;
}

const operations = (expression: string, engine: MaligatorBuildConfig["engine"] = {}) =>
	coreOperations(compile(expression, engine));

const isArray = (operation: ReturnType<typeof operations>[number]) =>
	operation.opcode === "callKnown" && operation.attributes.operation === "Array.isArray";

describe("private singleton flat iteration", () => {
	it.each(["some", "every", "forEach"])(
		"guards the allocation branch of %s with Proxy-aware IsArray",
		(name) => {
			const fn = compile(`[input].flat().${name}((value, index) => value === index)`);
			const result = coreOperations(fn);
			const guard = result.find(isArray)!;
			expect(guard).toBeDefined();
			const fallback = result.filter(
				({ opcode, attributes }) =>
					opcode === "createArray" ||
					(opcode === "callKnown" && attributes.operation === "Array.prototype.flat"),
			);
			expect(fallback).toHaveLength(2);
			const blocks = new Map(coreBlocks(fn).map((block) => [block.id, block]));
			const branch = blocks.get(guard.block)!.terminator;
			expect(branch.kind).toBe("branch");
			if (branch.kind !== "branch") throw new Error("missing IsArray branch");
			expect(branch.condition).toBe(guard.outputs[0]);
			for (const operation of fallback)
				expect(operation.block).toBe(branch.consequent.block);
			const pending = [branch.alternate.block];
			const visited = new Set<typeof guard.block>();
			while (pending.length !== 0) {
				const id = pending.pop()!;
				if (visited.has(id)) continue;
				visited.add(id);
				expect(fallback.some((operation) => operation.block === id)).toBe(false);
				const terminator = blocks.get(id)!.terminator;
				if (terminator.kind === "jump") pending.push(terminator.edge.block);
				else if (terminator.kind === "branch") {
					pending.push(terminator.alternate.block);
					if (terminator.condition !== guard.outputs[0])
						pending.push(terminator.consequent.block);
				}
			}
			expect(result.some(({ opcode }) => opcode === "createFunction")).toBe(false);
		},
	);

	it.each([
		{ primordials: "mutable" as const, realms: false },
		{ primordials: "locked" as const, realms: true },
		{ primordials: "mutable" as const, realms: true },
	])("versions the full generic sequence with world %j", (engine) => {
		const result = operations("[input].flat().some(value => value === 0)", engine);
		expect(result.some(isArray)).toBe(false);
		expect(
			result.filter(
				({ opcode, attributes }) =>
					opcode === "loadIntrinsic" &&
					attributes.intrinsic === "__arrayIterationEligible",
			),
		).toHaveLength(1);
		expect(
			result.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 17,
			),
		).toBe(true);
		const fallback = result.find(
			({ opcode, attributes }) =>
				opcode === "call" && attributes.guardedInlineFallback === true,
		)!;
		expect(fallback).toBeDefined();
		expect(
			result
				.filter(({ opcode }) => opcode === "createFunction")
				.map(({ block }) => block),
		).toEqual([fallback.block]);
		expect(result.filter(({ opcode }) => opcode === "createArray")).toHaveLength(2);
		expect(
			result.some(
				({ opcode, attributes }) =>
					opcode === "loadIntrinsic" && attributes.intrinsic === "__arrayFlatMapAppend",
			),
		).toBe(true);
	});

	it.each([
		"[input].flat().some((value, index, array) => array.length === 1)",
		"[input].flat().some(function () { return arguments[2].length === 1; })",
		"[input].flat().some((...args) => args[2].length === 1)",
		"[input].flat(0).some(value => value === 0)",
		"[input, input].flat().some(value => value === 0)",
		"((array) => { globalThis.saved = array; return array.some(value => value === 0); })([input].flat())",
		"((source) => { source.constructor = class extends Array {}; return source.flat().some(value => value === 0); })([input])",
	])("preserves observable or unsupported arrays: %s", (expression) => {
		const result = operations(expression);
		expect(result.some(isArray)).toBe(false);
		expect(result.some(({ opcode }) => opcode === "createArray")).toBe(true);
	});
	it.each([
		"[input].flat().some((value, index, array) => array.length === 1)",
		"[input].flat().some(function () { return arguments[2].length === 1; })",
		"[input].flat().some((...args) => args[2].length === 1)",
		"[input].flat(0).some(value => value === 0)",
		"[input, input].flat().some(value => value === 0)",
		"[input].flat().some(value => value === 0, globalThis.effect())",
		"((source) => { source.constructor = class extends Array {}; return source.flat().some(value => value === 0); })([input])",
	])("retains observable generic sequencing: %s", (expression) => {
		const result = operations(expression, { primordials: "mutable", realms: true });
		expect(
			result.some(
				({ opcode, attributes }) => opcode === "createNumber" && attributes.value === 17,
			),
		).toBe(false);
	});
});
