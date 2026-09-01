import { expect, test } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import type { CoreProgram } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { coreBlocks, coreFunctionNamed } from "./helpers/core-inspection.ts";

function functionNamed(program: CoreProgram, name: string) {
	const fn = coreFunctionNamed(program, name);
	expect(fn, `no Core function named ${name}`).toBeDefined();
	return fn!;
}

test("mixed parameter arguments reads materialize only on an observing body path", () => {
	const program = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(
			`function mixed(value = arguments.length, observe) {
				if (!observe) return value;
				return arguments;
			}
			mixed(undefined, false);`,
			"arguments-lazy-materialization.js",
		),
	).program;
	const fn = functionNamed(program, "mixed");
	const blocks = coreBlocks(fn);
	const opcodes = blocks.flatMap(({ instructions }) =>
		instructions.map(({ opcode }) => opcode),
	);
	const materializationBlocks = blocks.filter(({ instructions }) =>
		instructions.some(({ opcode }) => opcode === "createArgumentsObject"),
	);

	expect(opcodes.filter((opcode) => opcode === "loadArgumentCount")).toHaveLength(1);
	expect(materializationBlocks).toHaveLength(1);
	const entry = blocks.find(({ id }) => id === fn.entry)!;
	expect(entry.terminator.kind).toBe("jump");
	const prologue = blocks.find(
		({ id }) => entry.terminator.kind === "jump" && id === entry.terminator.edge.block,
	)!;
	expect(materializationBlocks[0]!.id).not.toBe(prologue.id);
	expect(
		prologue.instructions.some(({ opcode }) => opcode === "createArgumentsObject"),
	).toBe(false);
});

test("direct eval and arrow capture retain eager arguments materialization", () => {
	const program = lowerSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(
			`function captured(value = (() => arguments.length)()) { return arguments; }
			function evaluated(value = eval("arguments.length")) { return arguments; }`,
			"arguments-eager-materialization.js",
		),
	).program;

	for (const name of ["captured", "evaluated"]) {
		const fn = functionNamed(program, name);
		const blocks = coreBlocks(fn);
		const entry = blocks.find(({ id }) => id === fn.entry)!;
		expect(entry.terminator.kind).toBe("jump");
		const prologue = blocks.find(
			({ id }) => entry.terminator.kind === "jump" && id === entry.terminator.edge.block,
		)!;
		expect(
			prologue.instructions.some(({ opcode }) => opcode === "createArgumentsObject"),
		).toBe(true);
		expect(
			blocks
				.flatMap(({ instructions }) => instructions)
				.some(({ opcode }) => opcode === "loadArgumentCount"),
		).toBe(false);
	}
});
