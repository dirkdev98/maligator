import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import type { CoreTargetFunction } from "../src/compiler/target/core-target-ir.ts";
import { lowerCoreCompilationToExecutionProgram } from "../src/compiler/target/lower-execution.ts";
import { layoutNativeBlocks } from "../src/compiler/target/lower-native-control-flow.ts";
import { lowerCoreCompilationToNativeProgram } from "../src/compiler/target/lower-native.ts";
import { lowerVerifiedTargetsToRuntimePlans } from "../src/compiler/target/runtime-image.ts";

function compile(source: string) {
	return optimizeSemanticProgramToCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/native-layout.js"),
		{},
		(_phase, run) => run(),
	);
}

describe("native block layout", () => {
	it("threads one-owner unconditional copies without changing Core block order", () => {
		const blocks: CoreTargetFunction["blocks"] = [
			{ instructions: [{ type: "jump", blocks: [3] }] },
			{
				instructions: [
					{ type: "jumpIf", registers: [0], blocks: [4] },
					{ type: "jump", blocks: [5] },
				],
			},
			{ instructions: [{ type: "return", registers: [0] }] },
			{
				instructions: [
					{ type: "move", registers: [1, 0] },
					{ type: "jump", blocks: [1] },
				],
			},
			{
				instructions: [
					{ type: "move", registers: [1, 0] },
					{ type: "jump", blocks: [2] },
				],
			},
			{
				instructions: [
					{ type: "move", registers: [1, 0] },
					{ type: "jump", blocks: [2] },
				],
			},
		];
		expect(layoutNativeBlocks(blocks, 3)).toEqual([0, 3, 1, 5, 2, 4]);
	});

	it("leaves shared copies at the tail and keeps protected block markers intact", () => {
		const blocks: CoreTargetFunction["blocks"] = [
			{
				instructions: [
					{ type: "tryBegin", blocks: [2, 0] },
					{ type: "jump", blocks: [3] },
					{ type: "tryEnd" },
				],
			},
			{ instructions: [{ type: "jump", blocks: [3] }] },
			{
				instructions: [
					{ type: "catch", registers: [0] },
					{ type: "return", registers: [0] },
				],
			},
			{
				instructions: [
					{ type: "move", registers: [1, 0] },
					{ type: "jump", blocks: [1] },
				],
			},
		];
		expect(layoutNativeBlocks(blocks, 3)).toEqual([0, 1, 2, 3]);
	});

	it("gives real native phi edges fallthrough while leaving VM layout alone", () => {
		const core = compile(`globalThis.choose = (condition, left, right) => {
			let value;
			if (condition) value = left; else value = right;
			globalThis.observe(value);
			return value;
		};`);
		const native = lowerCoreCompilationToNativeProgram(core);
		const vm = lowerCoreCompilationToExecutionProgram(core);
		const fn = native.functions[1]!;
		const copyStarts = new Set(
			fn.parallelCopies
				.filter((copy) => copy.kind === "edge")
				.map((copy) => copy.moves[0]),
		);
		const threaded = fn.blocks.flatMap(({ instructions }, block) => {
			const last = instructions.at(-1);
			if (last?.type !== "jump") return [];
			const target = fn.blocks[last.blocks[0]]!;
			const first = target.instructions[0];
			return first?.type === "move" && copyStarts.has(first)
				? [{ block, target: last.blocks[0] }]
				: [];
		});
		expect(threaded.length).toBeGreaterThan(0);
		for (const edge of threaded) expect(edge.target).toBe(edge.block + 1);
		expect(
			vm.functions.every((fn) =>
				fn.blocks.every((block) => block.sourcePosition === undefined),
			),
		).toBe(true);
		const [nativePlan, vmPlan] = lowerVerifiedTargetsToRuntimePlans([native, vm]);
		const fallthroughs = (plan: typeof nativePlan) =>
			plan!.functions[1]!.bytecode.instructions.filter(
				(instruction, ip) =>
					instruction.opcode === "JUMP" && instruction.targetIp === ip + 1,
			).length;
		expect(fallthroughs(nativePlan)).toBeGreaterThan(fallthroughs(vmPlan));
	});

	it("preserves operation source positions and handler transport after copy threading", () => {
		const core = compile(`globalThis.rotate = (left, right, count) => {
			for (let index = 0; index < count; index++) {
				const saved = left; left = right; right = saved;
				try { globalThis.observe(left); }
				catch (error) { globalThis.recover(error, right); }
			}
			return left;
		};`);
		const native = lowerCoreCompilationToNativeProgram(core);
		const [plan] = lowerVerifiedTargetsToRuntimePlans([native]);
		const fn = native.functions[1]!;
		const source = core.program.function(native.functionMap.executionToCore[1]!);
		let checked = 0;
		for (const point of fn.gc.safepoints) {
			if (point.kind !== "operation") continue;
			const position = source.instructionSourcePosition(point.coreInstruction);
			if (position === undefined) continue;
			const ip = plan!.functions[1]!.instructionIndexByTargetInstruction.get(
				point.instruction,
			)!;
			const actual =
				plan!.compacted.runtime.sourcePositions[
					plan!.functions[1]!.bytecode.positions[ip]!
				];
			expect(actual).toMatchObject(core.program.sourcePositions[position]!);
			checked++;
		}
		expect(checked).toBeGreaterThan(0);
		expect(fn.gc.safepoints.some((point) => point.kind === "loop-backedge")).toBe(true);
		expect(plan!.functions[1]!.bytecode.handlers.length).toBeGreaterThan(0);
	});
});
