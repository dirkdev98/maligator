import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { lowerPrimitiveOperations } from "../src/compiler/core/core-primitive-operations.ts";
import { CoreStaticValueAnalysis } from "../src/compiler/core/core-static-values.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { programAnalysisContext } from "./helpers/core-program-analysis.ts";

describe("primitive brand and identity fact demand", () => {
	it.each(["object", "array"] as const)(
		"does not replay mutable %s contents for equality and string-length admission",
		(kind) => {
			const context = programAnalysisContext(false);
			const program = new CoreProgram(coreOpcodeRegistry, {
				stringConstants: [[108, 101, 110, 103, 116, 104]],
			});
			const builder = new CoreFunctionBuilder(program);
			const entry = builder.createBlock(),
				after = builder.createBlock();
			const [initial] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 7 },
			});
			const [value] =
				kind === "object"
					? builder.appendInstruction(entry, "createObjectShaped", [initial!], {
							attributes: { keyStringIndices: [0] },
						})
					: builder.appendInstruction(entry, "createArray", [], {
							attributes: { length: 7 },
						});
			const [updated] = builder.appendInstruction(entry, "createNumber", [], {
				attributes: { value: 9 },
			});
			builder.appendInstruction(entry, "storePropertyStatic", [value!, updated!], {
				attributes: { stringIndex: 0 },
			});
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: after, arguments: [] },
			});
			const [alias] = builder.appendInstruction(after, "move", [value!]);
			const [length] = builder.appendInstruction(after, "loadPropertyStatic", [alias!], {
				attributes: { stringIndex: 0 },
			});
			builder.appendInstruction(after, "binary", [alias!, value!], {
				attributes: { operator: "===" },
			});
			builder.setTerminator(after, { kind: "return", value: length! });
			const fn = program.function(builder.finish(entry).function);
			let controlQueries = 0;
			const analysis = new CoreStaticValueAnalysis(program, fn, () => {
				controlQueries++;
				return buildCoreControlFlow(program, fn.id);
			});
			const changes = lowerPrimitiveOperations.run({
				program,
				compilationContext: context,
				item: { function: fn.id },
				remainingEdits: 100,
				deferForBudget() {
					throw new Error("Unexpected budget exhaustion");
				},
				analysis: () => analysis as never,
			});
			expect(changes).toBeUndefined();
			expect(controlQueries).toBe(0);
			const consumer = coreInstructionId(fn.kernel.valueDefinitionOwner(length!));
			const observed = analysis.queryPropertyAt(alias!, "length", consumer);
			if (observed === undefined) throw new Error("Expected length");
			const current =
				observed.member.kind === "constant"
					? analysis.descriptionConstant(observed.member.description)
					: analysis.constant(observed.operands[observed.member.index]!, consumer);
			expect(current).toEqual({
				kind: "number",
				value: 9,
			});
			expect(controlQueries).toBeGreaterThan(0);
		},
	);
});
