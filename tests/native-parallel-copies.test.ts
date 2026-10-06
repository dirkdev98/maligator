import { describe, expect, it } from "vitest";
import type { CoreRepresentation } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import type { CoreTargetRegisterRepresentation } from "../src/compiler/target/core-target-ir.ts";
import { createNativeParallelCopyLowerer } from "../src/compiler/target/lower-native-copies.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import type { NativeFunction, NativeProgram } from "../src/compiler/target/native-ir.ts";
import { verifyExecutionProgram } from "../src/compiler/target/verify-execution.ts";
import { verifyNativeExecutionProgram } from "../src/compiler/target/verify-native-execution.ts";

const ROTATION = `function rotate(left, right, count) {
	for (let index = 0; index < count; index++) {
		const saved = left; left = right; right = saved;
	}
	for (let index = 0; index < count; index++) {
		const saved = left; left = right; right = saved;
	}
	return left + right;
}
globalThis.rotate = rotate;
globalThis.result = rotate(3, 7, 4);`;

function rotation() {
	const core = optimizeSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(ROTATION, "/native-copies.js"),
		{},
		(_phase, run) => run(),
	);
	const program = lowerCoreCompilationToNativeProgram(core);
	const fn = program.functions.find((fn) => fn.parameterCount === 3)!;
	const copies = fn.parallelCopies.filter((copy) => copy.temporaries.length > 0);
	return { program, fn, copies };
}

function replaceFunction(program: NativeProgram, fn: NativeFunction): NativeProgram {
	return { ...program, functions: program.functions.with(fn.functionIndex, fn) };
}

describe("native parallel copies", () => {
	it("preserves simultaneous fanout and disjoint cycles while reusing drained scratch", () => {
		const representations = new Map<number, CoreRepresentation>(
			Array.from({ length: 6 }, (_, register) => [register, "boxed"]),
		);
		const canonical = new Map<number, CoreTargetRegisterRepresentation>(
			Array.from({ length: 6 }, (_, register) => [register, "boxed"]),
		);
		const lowerer = createNativeParallelCopyLowerer(
			{ value: 6 },
			representations,
			canonical,
			[],
		);
		const assignments = [
			{ destination: 0, source: 1 },
			{ destination: 1, source: 0 },
			{ destination: 2, source: 0 },
			{ destination: 3, source: 4 },
			{ destination: 4, source: 3 },
			{ destination: 5, source: 5 },
		];
		const copy = lowerer.lower(assignments);
		const originals = ["first", "second", "fanout", "third", "fourth", "untouched"];
		const state = [...originals];
		for (const {
			registers: [destination, source],
		} of copy.moves)
			state[destination] = state[source]!;
		for (const { destination, source } of assignments)
			expect(state[destination]).toBe(originals[source]);
		expect(copy.temporaries).toHaveLength(1);
		expect(lowerer.lower(assignments).temporaries).toEqual(copy.temporaries);
	});

	it("separates scratch by the canonical class and every selected entry class", () => {
		const representations = new Map<number, CoreRepresentation>(
			Array.from({ length: 6 }, (_, register) => [register, "boxed"]),
		);
		const table = (classes: Array<CoreTargetRegisterRepresentation>) =>
			new Map(classes.map((representation, register) => [register, representation]));
		const lowerer = createNativeParallelCopyLowerer(
			{ value: 6 },
			representations,
			table(["boxed", "boxed", "boxed", "boxed", "number", "number"]),
			[
				table(["number", "number", "number", "number", "number", "number"]),
				table(["number", "number", "boolean", "boolean", "number", "number"]),
			],
		);
		const scratches = [0, 2, 4].map(
			(register) =>
				lowerer.lower([
					{ destination: register, source: register + 1 },
					{ destination: register + 1, source: register },
				]).temporaries[0]!,
		);
		expect(new Set(scratches).size).toBe(3);
		expect(
			scratches.map((scratch) => lowerer.temporaryRepresentations.get(scratch)),
		).toEqual([
			["number", "number"],
			["number", "boolean"],
			["number", "number"],
		]);
	});

	it("retains numeric typed phi storage and shares scratch across real merge blocks", () => {
		const { program, fn, copies } = rotation();
		expect(copies).toHaveLength(2);
		const scratch = copies[0]!.temporaries[0]!;
		expect(copies[1]!.temporaries).toEqual([scratch]);
		expect(fn.registerRepresentations[scratch]).toBe("boxed");
		const numeric = fn.directEntries.find((entry) =>
			entry.parameterRepresentations.every(
				(representation) => representation === "number",
			),
		)!;
		expect(numeric).toBeDefined();
		expect(numeric.registerRepresentations[scratch]).toBe("number");
		for (const copy of copies)
			for (const { destination, source } of copy.assignments) {
				expect(numeric.registerRepresentations[destination]).toBe("number");
				expect(numeric.registerRepresentations[source]).toBe("number");
			}
		expect(() => verifyNativeExecutionProgram(program)).not.toThrow();
		expect(
			fn.gc.safepoints.every((point) => !point.rootRegisters.includes(scratch)),
		).toBe(true);
	});

	it("requires a scratch save in every copy even after earlier copies used it", () => {
		const { program, fn, copies } = rotation();
		const copy = copies[1]!;
		const scratch = copy.temporaries[0]!;
		const read = {
			type: "move" as const,
			registers: [scratch, scratch] as [number, number],
		};
		const block = fn.blocks.findIndex(({ instructions }) =>
			instructions.includes(copy.moves[0]!),
		);
		const instructions = [...fn.blocks[block]!.instructions];
		instructions.splice(instructions.indexOf(copy.moves[0]!), 0, read);
		const broken = replaceFunction(program, {
			...fn,
			blocks: fn.blocks.with(block, { instructions }),
			parallelCopies: fn.parallelCopies.with(fn.parallelCopies.indexOf(copy), {
				...copy,
				moves: [read, ...copy.moves],
			}),
		});
		expect(() => verifyExecutionProgram(broken)).toThrow(
			"parallel-copy temporary is read before its definition in this copy",
		);
	});

	it("rejects scratch escapes and semantic scratch operands", () => {
		const { program, fn, copies } = rotation();
		const copy = copies[0]!;
		const scratch = copy.temporaries[0]!;
		const block = fn.blocks.findIndex(({ instructions }) =>
			instructions.includes(copy.moves[0]!),
		);
		const instructions = [...fn.blocks[block]!.instructions];
		instructions.splice(instructions.indexOf(copy.moves.at(-1)!) + 1, 0, {
			type: "move",
			registers: [scratch, scratch],
		});
		expect(() =>
			verifyExecutionProgram(
				replaceFunction(program, {
					...fn,
					blocks: fn.blocks.with(block, { instructions }),
				}),
			),
		).toThrow("native copy scratch escapes its declared parallel copy");
		expect(() =>
			verifyExecutionProgram(
				replaceFunction(program, {
					...fn,
					parallelCopies: fn.parallelCopies.with(fn.parallelCopies.indexOf(copy), {
						...copy,
						assignments: [...copy.assignments, { destination: scratch, source: scratch }],
					}),
				}),
			),
		).toThrow("parallel-copy temporary must not be a semantic operand");
	});

	it("keeps VM temporary ownership confined to one block", () => {
		const { program } = rotation();
		const vm = { ...program, kind: "vm" };
		expect(() => verifyExecutionProgram(vm)).toThrow(
			"temporary register is defined in more than one block",
		);
	});
});
