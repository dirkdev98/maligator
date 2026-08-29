import type { CoreCompilation } from "../core/core-compilation.ts";
import { coreOpcodeRegistry } from "../core/core-ir-opcodes.ts";
import {
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	coreExactCallArgumentRepresentations,
} from "../core/core-ir-value-kinds.ts";
import { verifyCoreProgram } from "../core/core-ir-verifier.ts";
import type {
	CoreFunction,
	CoreInstruction,
	CoreProgram,
	CoreRepresentation,
} from "../core/core-ir.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type {
	DirectEntryPlan,
	LowerCoreToExecutionOptions,
	PlannedDirectEntry,
} from "./lower-execution.ts";
import {
	lowerCoreCompilationWithDirectEntries,
	physicalRegisterClass,
} from "./lower-execution.ts";
import { verifyNativeExecutionProgram } from "./verify-native-execution.ts";

const MAX_DIRECT_ENTRIES_PER_FUNCTION = 4;

function corePhysicalRepresentation(
	representation: CoreRepresentation,
): "boxed" | "int32" | "number" | "boolean" | "string" {
	return physicalRegisterClass(representation);
}

function directEntryResultRepresentation(
	fn: CoreFunction,
): "boxed" | "int32" | "number" | "boolean" | "string" {
	const representationsByValue = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	const returns = fn.blocks.flatMap(({ terminator }) =>
		terminator.kind === "return" ? [terminator.value] : [],
	);
	if (returns.length === 0) return "boxed";
	const representations = returns.map((value) =>
		corePhysicalRepresentation(representationsByValue.get(value)!),
	);
	const first = representations[0]!;
	return first !== "boxed" && representations.every((entry) => entry === first)
		? first
		: "boxed";
}

const RAW_ARGUMENT_OPCODES = new Set([
	"loadArgumentCount",
	"loadArgument",
	"loadStaticArgument",
	"createArgumentsObject",
	"createRestArguments",
]);

function supportsDirectEntry(fn: CoreFunction): boolean {
	return (
		!fn.isGenerator &&
		!fn.isAsync &&
		!fn.metadata.isClassConstructor &&
		!fn.metadata.isDerivedConstructor &&
		!fn.metadata.mappedArguments &&
		!fn.blocks.some(({ instructions }) =>
			instructions.some(({ opcode }) => RAW_ARGUMENT_OPCODES.has(opcode)),
		)
	);
}

/** Select a bounded set of explicit native ABIs from the final closed call graph. */
function planDirectEntries(core: CoreProgram): DirectEntryPlan {
	interface Candidate {
		readonly key: string;
		readonly parameters: ReadonlyArray<
			"boxed" | "int32" | "number" | "boolean" | "string"
		>;
		readonly result: "boxed" | "int32" | "number" | "boolean" | "string";
		readonly calls: Array<CoreInstruction>;
		uses: number;
	}
	const candidates = core.functions.map(() => new Map<string, Candidate>());
	const addCandidate = (
		targetIndex: number,
		parameters: ReadonlyArray<"boxed" | "int32" | "number" | "boolean" | "string">,
		result: "boxed" | "int32" | "number" | "boolean" | "string",
		call?: CoreInstruction,
	): void => {
		const key = `${parameters.join(",")}->${result}`;
		const existing = candidates[targetIndex]!.get(key);
		if (existing === undefined) {
			candidates[targetIndex]!.set(key, {
				key,
				parameters,
				result,
				calls: call === undefined ? [] : [call],
				uses: 1,
			});
		} else {
			existing.uses++;
			if (call !== undefined) existing.calls.push(call);
		}
	};
	for (const caller of core.functions) {
		const callerRepresentations = new Map(
			caller.values.map(({ id, representation }) => [id, representation] as const),
		);
		for (const block of caller.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.opcode !== "call") continue;
				if (instruction.attributes.directFunctionCall === true) continue;
				const targetIndex = instruction.attributes.directFunctionIndex;
				if (typeof targetIndex !== "number") continue;
				const target = core.functions[targetIndex];
				if (target === undefined || !supportsDirectEntry(target)) continue;
				const exactArguments = coreExactCallArgumentRepresentations(
					instruction.attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE],
					target.parameters.length,
				);
				const parameters = target.parameters.map((_, index) => {
					const argument = instruction.inputs[index + 2];
					const exact = exactArguments?.[index];
					if (
						exact === "int32" ||
						exact === "number" ||
						exact === "boolean" ||
						exact === "string"
					) {
						return exact;
					}
					return argument === undefined
						? ("boxed" as const)
						: corePhysicalRepresentation(callerRepresentations.get(argument)!);
				});
				const result = directEntryResultRepresentation(target);
				if (result === "boxed" && parameters.every((entry) => entry === "boxed")) {
					continue;
				}
				addCandidate(targetIndex, parameters, result, instruction);
			}
		}
	}
	const entryByCall = new Map<CoreInstruction, number>();
	const entriesByFunction = candidates.map((bySignature) =>
		[...bySignature.values()]
			.sort((left, right) => right.uses - left.uses || left.key.localeCompare(right.key))
			.slice(0, MAX_DIRECT_ENTRIES_PER_FUNCTION)
			.map((candidate, id): PlannedDirectEntry => {
				for (const call of candidate.calls) entryByCall.set(call, id);
				return {
					id,
					parameterRepresentations: candidate.parameters,
					resultRepresentation: candidate.result,
				};
			}),
	);
	return { entriesByFunction, entryByCall };
}

/** Select and allocate canonical Core plus native-only direct-entry overlays. */
export function lowerCoreCompilationToExecution(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	const { program: core, context } = compilation;
	// Owned boundary: lowering may consume Core decisions but never repairs them.
	verifyCoreProgram(
		core,
		coreOpcodeRegistry,
		{ stage: "pre-target" },
		context,
		compilation.targetAnalyses,
	);
	const program = lowerCoreCompilationWithDirectEntries(
		compilation,
		planDirectEntries(core),
		options,
	);
	// Owned boundary: no native-plan consumer may observe an unverified ABI variant.
	verifyNativeExecutionProgram(program);
	return program;
}
