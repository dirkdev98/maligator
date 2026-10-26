import type { CorePlanRepresentation } from "../core/core-ir-regions.ts";
import {
	coreNativeEntryControlFlow,
	coreNativeEntryProofIsCurrent,
} from "../core/core-native-entry-analysis.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import {
	targetRecordStorageFieldsAreValid,
	targetRecordStorageFieldsEqual,
} from "./core-target-ir.ts";
import type {
	ExecutionDirectEntry,
	ExecutionFunction,
	ExecutionProgram,
	ExecutionRegisterRepresentation,
} from "./execution-ir.ts";
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

function verifyUnreachableCopies(
	fn: ExecutionFunction,
	core: CoreFunctionStore,
	entry: ExecutionDirectEntry,
): ReadonlySet<CompilerInstruction> | undefined {
	const proof = entry.unreachableCopies;
	if (proof === undefined) return undefined;
	const reject = (): never => {
		throw new ExecutionVerificationError(
			"native direct entry has an invalid unreachable-copy proof",
			{ functionIndex: fn.functionIndex },
		);
	};
	const sameRepresentations = (
		source: ReadonlyArray<CorePlanRepresentation> | undefined,
		target: ReadonlyArray<ExecutionRegisterRepresentation> | undefined,
	): boolean =>
		source === undefined
			? target === undefined
			: target !== undefined &&
				source.length === target.length &&
				source.every(
					(representation, index) =>
						(representation === "f64"
							? "number"
							: representation === "i32"
								? "int32"
								: representation) === target[index],
				);
	const control = coreNativeEntryControlFlow(core, proof.source);
	if (
		control === undefined ||
		!coreNativeEntryProofIsCurrent(core, proof.source) ||
		proof.source.function !== core.id ||
		proof.source.id !== entry.id ||
		fn.storageValues === undefined ||
		!sameRepresentations(
			proof.source.parameterRepresentations,
			entry.parameterRepresentations,
		) ||
		!sameRepresentations(
			proof.source.argumentRepresentations,
			entry.argumentRepresentations,
		) ||
		!sameRepresentations(
			proof.source.fieldParameters?.representations,
			entry.fieldParameters?.representations,
		) ||
		!sameRepresentations(
			[proof.source.resultRepresentation],
			[entry.resultRepresentation],
		)
	)
		reject();
	const edges = new Set<number>();
	for (const block of fn.coreBlocks) {
		const terminator = core.blockTerminator(block);
		const start = core.kernel.terminatorEdgeStart(terminator);
		for (let index = 0; index < core.kernel.terminatorEdgeCount(terminator); index++)
			edges.add(start + index);
	}
	const copies = new Set(fn.parallelCopies);
	const moves = new Set<CompilerInstruction>();
	const claimed = new Set<number>();
	for (const { edge, copy } of proof.copies) {
		if (
			!edges.has(edge) ||
			control!.ordinaryEdges.has(edge) ||
			claimed.has(edge) ||
			!copies.has(copy) ||
			copy.kind !== "edge"
		)
			reject();
		claimed.add(edge);
		const target = core.kernel.terminatorEdgeBlock(edge);
		const parameters = core.kernel.blockParameterStart(target);
		const arguments_ = core.kernel.terminatorEdgeArgumentStart(edge);
		if (
			copy.assignments.length !== core.kernel.blockParameterCount(target) ||
			copy.assignments.length !== core.kernel.terminatorEdgeArgumentCount(edge) ||
			!copy.assignments.every(
				({ source, destination }, index) =>
					fn.storageValues![source] === core.kernel.operandAt(arguments_ + index) &&
					fn.storageValues![destination] ===
						core.kernel.blockParameterValue(parameters + index),
			)
		)
			reject();
		for (const move of copy.moves) {
			if (moves.has(move)) reject();
			moves.add(move);
		}
	}
	return moves;
}

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
		if (
			fn.recordObjects?.some(
				(record) =>
					record.allocation.type !== "createObjectShaped" ||
					!targetRecordStorageFieldsAreValid(
						record.storage,
						record.allocation.keyStringIndices.length,
					),
			)
		)
			throw new ExecutionVerificationError("native record object has invalid storage", {
				functionIndex,
			});
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
			if (
				(entry.resultFields !== undefined &&
					!targetRecordStorageFieldsAreValid(
						entry.resultFields.storage,
						entry.resultFields.keys.length,
					)) ||
				entry.recordParameters?.some(
					(parameter) =>
						!targetRecordStorageFieldsAreValid(parameter.storage, parameter.keys.length),
				)
			)
				throw new ExecutionVerificationError("native record entry has invalid storage", {
					functionIndex,
				});
			const overriddenInstructions = new Set<CompilerInstruction>();
			for (const call of entry.callOverrides ?? []) {
				const target = program.functions[call.functionIndex]?.directEntries[call.entryId];
				if (
					!instructions.has(call.instruction) ||
					overriddenInstructions.has(call.instruction) ||
					call.instruction.type !== "call" ||
					target?.id !== call.entryId ||
					target.fieldParameters !== undefined ||
					target.recordParameters !== undefined ||
					(target.resultFields !== undefined &&
						(call.guarded === true ||
							!(entry.resultFields?.forwards ?? []).some(
								(forward) =>
									forward.instruction === call.instruction &&
									forward.functionIndex === call.functionIndex,
							))) ||
					(target.argumentRepresentations !== undefined &&
						target.argumentRepresentations.length !==
							call.instruction.registers.length - 3) ||
					(call.guarded !== undefined && call.guarded !== true)
				)
					throw new ExecutionVerificationError(
						"native direct entry has an invalid call override",
						{ functionIndex },
					);
				if (
					target.resultFields !== undefined &&
					(entry.resultFields === undefined ||
						!targetRecordStorageFieldsEqual(
							entry.resultFields.storage,
							target.resultFields.storage,
						))
				)
					throw new ExecutionVerificationError(
						"native record forward has incompatible storage",
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
				verifyUnreachableCopies(
					fn,
					program.core.function(program.functionMap.executionToCore[functionIndex]!),
					entry,
				),
			);
		}
	}
	verifiedNativeExecutionPrograms.add(program);
}
