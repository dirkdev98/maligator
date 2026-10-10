import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	nativeLoopBackedgeInstructions,
} from "./execution-liveness.ts";
import {
	ExecutionVerificationError,
	verifyExecutionFunctionRepresentationVariant,
	verifyExecutionProgram,
} from "./verify-execution.ts";

const verifiedNativeExecutionPrograms = new WeakSet<ExecutionProgram>();

/** Verify the generic target before native image planning consumes it. */
export function verifyNativeExecutionProgram(program: ExecutionProgram): void {
	if (verifiedNativeExecutionPrograms.has(program)) return;
	const loopBackedgeInstructions =
		"kind" in program && program.kind === "native"
			? nativeLoopBackedgeInstructions
			: executionLoopBackedgeInstructions;
	verifyExecutionProgram(program, loopBackedgeInstructions);
	for (const [functionIndex, fn] of program.functions.entries()) {
		if (fn.directEntries.length > 4) {
			throw new ExecutionVerificationError(
				"native function has too many direct entries",
				{
					functionIndex,
				},
			);
		}
		if (fn.directEntries.length === 0) continue;
		const instructions = new Set(fn.blocks.flatMap((block) => block.instructions));
		for (const [entryIndex, entry] of fn.directEntries.entries()) {
			if (
				entry.id !== entryIndex ||
				entry.parameterRepresentations.length !== fn.parameterCount ||
				entry.registerRepresentations.length !== fn.registerCount ||
				entry.parameterRepresentations.some(
					(representation, parameter) =>
						entry.registerRepresentations[parameter] !== representation,
				)
			) {
				throw new ExecutionVerificationError("native direct entry has an invalid ABI", {
					functionIndex,
				});
			}
			const overriddenInstructions = new Set<CompilerInstruction>();
			for (const call of entry.callOverrides ?? []) {
				const target = program.functions[call.functionIndex]?.directEntries[call.entryId];
				if (
					!instructions.has(call.instruction) ||
					overriddenInstructions.has(call.instruction) ||
					call.instruction.type !== "call" ||
					target?.id !== call.entryId ||
					target.fieldParameters !== undefined ||
					(target.argumentRepresentations !== undefined &&
						target.argumentRepresentations.length !==
							call.instruction.registers.length - 3) ||
					(call.guarded !== undefined && call.guarded !== true)
				)
					throw new ExecutionVerificationError(
						"native direct entry has an invalid call override",
						{ functionIndex },
					);
				overriddenInstructions.add(call.instruction);
			}
			verifyExecutionFunctionRepresentationVariant(
				{
					...fn,
					registerRepresentations: entry.registerRepresentations,
					gc: entry.gc,
				},
				program.core.function(program.functionMap.executionToCore[functionIndex]!),
				functionIndex,
				loopBackedgeInstructions,
				{
					suppliedArguments: entry.argumentRepresentations?.length,
					discharged: entry.gc.discharged ?? [],
				},
			);
		}
	}
	verifiedNativeExecutionPrograms.add(program);
}
