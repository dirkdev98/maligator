import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import type { CoreFunctionStore } from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import {
	inspectCoreBlockParameters,
	inspectCoreFunctionParameters,
	inspectCoreTerminatorPayload,
} from "./helpers/core-inspection.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

function loadCount(fn: CoreFunctionStore): number {
	return [...fn.instructionIds()].filter(
		(instruction) =>
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadGlobal",
	).length;
}

describe("Core memory joins", () => {
	it("reuses a partitioned load only when every incoming path preserves it", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 2 });
		const build = (clobber: boolean): CoreFunctionId => {
			const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
			const entry = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const [original, replacement, condition] = inspectCoreBlockParameters(
				builder,
				entry,
			).map(({ value }) => value);
			const left = builder.createBlock();
			const right = builder.createBlock();
			const join = builder.createBlock();
			builder.appendInstruction(entry, "storeGlobal", [original!], {
				attributes: { index: 0 },
			});
			builder.setTerminator(entry, {
				kind: "branch",
				condition: condition!,
				consequent: { block: left, arguments: [] },
				alternate: { block: right, arguments: [] },
			});
			builder.appendInstruction(left, "storeGlobal", [replacement!], {
				attributes: { index: clobber ? 0 : 1 },
			});
			builder.setTerminator(left, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			builder.setTerminator(right, {
				kind: "jump",
				edge: { block: join, arguments: [] },
			});
			const [loaded] = builder.appendInstruction(join, "loadGlobal", [], {
				attributes: { index: 0 },
			});
			builder.setTerminator(join, { kind: "return", value: loaded! });
			return builder.finish(entry).function;
		};
		const clean = build(false);
		const clobbered = build(true);

		const optimized = optimizeCore(
			{ program, context: programAnalysisContext() },
			{ verification: "per-pass" },
		).compilation.program;
		expect(loadCount(optimized.function(clean))).toBe(0);
		expect(loadCount(optimized.function(clobbered))).toBe(1);
		expect(
			[...optimized.function(clean).blockIds()].map((block) =>
				inspectCoreTerminatorPayload(
					optimized.function(clean),
					optimized.function(clean).blockTerminator(block),
				),
			),
		).toContainEqual({
			kind: "return",
			value: inspectCoreFunctionParameters(optimized.function(clean))[0],
		});
	});

	it("does not forward a normal-path store across an exceptional join", () => {
		const program = new CoreProgram(coreOpcodeRegistry, { globalCount: 1 });
		const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [object, key, original] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const protectedBlock = builder.createBlock();
		const normal = builder.createBlock();
		const handler = builder.createBlock([{ representation: "boxed", role: "exception" }]);
		const join = builder.createBlock();
		builder.appendInstruction(entry, "storeGlobal", [original!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		const [replacement] = builder.appendInstruction(protectedBlock, "loadProperty", [
			object!,
			key!,
		]);
		builder.setHandler(protectedBlock, handler, []);
		builder.setTerminator(protectedBlock, {
			kind: "jump",
			edge: { block: normal, arguments: [] },
		});
		builder.appendInstruction(normal, "storeGlobal", [replacement!], {
			attributes: { index: 0 },
		});
		builder.setTerminator(normal, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		builder.setTerminator(handler, {
			kind: "jump",
			edge: { block: join, arguments: [] },
		});
		const [loaded] = builder.appendInstruction(join, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		builder.setTerminator(join, { kind: "return", value: loaded! });
		const functionId = builder.finish(entry).function;

		const optimized = optimizeCore(
			{ program, context: programAnalysisContext() },
			{ verification: "per-pass" },
		).compilation.program;
		expect(loadCount(optimized.function(functionId))).toBe(1);
	});
});
