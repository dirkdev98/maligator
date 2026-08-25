import type { CoreFunction } from "../core/core-ir.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type { ExecutionVerificationContext } from "./verify-execution.ts";
import {
	ExecutionVerificationError,
	verifyExecutionFunctionRepresentationVariant,
	verifyExecutionProgram,
} from "./verify-execution.ts";

function fail(detail: string, context: ExecutionVerificationContext = {}): never {
	throw new ExecutionVerificationError(detail, context);
}

function coreRegisterRepresentation(
	representation: CoreFunction["values"][number]["representation"],
): "boxed" | "number" | "boolean" {
	if (representation === "f64" || representation === "i32") return "number";
	return representation === "boolean" ? "boolean" : "boxed";
}

function coreDirectResultRepresentation(
	fn: CoreFunction,
): "boxed" | "number" | "boolean" {
	const representationsByValue = new Map(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	const returns = fn.blocks.flatMap(({ terminator }) =>
		terminator.kind === "return" ? [terminator.value] : [],
	);
	if (returns.length === 0) return "boxed";
	const representations = returns.map((value) =>
		coreRegisterRepresentation(representationsByValue.get(value)!),
	);
	const first = representations[0]!;
	return first !== "boxed" && representations.every((entry) => entry === first)
		? first
		: "boxed";
}

function immediateRepresentation(value: unknown): "boxed" | "number" | "boolean" {
	if (typeof value !== "object" || value === null || !("kind" in value)) return "boxed";
	const kind = (value as { readonly kind?: string }).kind;
	return kind === "number" ? "number" : kind === "boolean" ? "boolean" : "boxed";
}

const ARRAY_ITERATION_CALLBACK_OPERATIONS: ReadonlySet<string> = new Set([
	"Array.prototype.forEach",
	"Array.prototype.some",
	"Array.prototype.every",
	"Array.prototype.find",
	"Array.prototype.findIndex",
	"Array.prototype.map",
	"Array.prototype.filter",
	"Array.prototype.reduce",
	"Array.prototype.reduceRight",
	"Array.prototype.findLast",
	"Array.prototype.findLastIndex",
	"Array.prototype.flatMap",
]);

/** Verify the canonical target plus every native-only direct-entry ABI variant. */
export function verifyNativeExecutionProgram(program: ExecutionProgram): void {
	verifyExecutionProgram(program);
	for (const [functionIndex, fn] of program.functions.entries()) {
		const core = program.core.functions[functionIndex]!;
		if (fn.directEntries.length > 4) {
			fail("function has more than four native direct entries", { functionIndex });
		}
		const signatures = new Set<string>();
		for (const [entryIndex, entry] of fn.directEntries.entries()) {
			const context = { functionIndex, opcode: `direct-entry:${entryIndex}` };
			if (entry.id !== entryIndex) fail("direct-entry ids must be dense", context);
			if (
				core.isGenerator ||
				core.isAsync ||
				core.metadata.isClassConstructor ||
				core.metadata.isDerivedConstructor ||
				core.metadata.mappedArguments ||
				core.blocks.some(({ instructions }) =>
					instructions.some(({ opcode }) =>
						[
							"loadArgumentCount",
							"loadArgument",
							"loadStaticArgument",
							"createArgumentsObject",
							"createRestArguments",
						].includes(opcode),
					),
				)
			) {
				fail("direct entry may not observe or retain the raw argument slice", context);
			}
			if (entry.parameterRepresentations.length !== fn.parameterCount) {
				fail("direct-entry parameter signature does not match function arity", context);
			}
			if (entry.registerRepresentations.length !== fn.registerCount) {
				fail("direct-entry register representation count mismatch", context);
			}
			for (const [register, representation] of entry.registerRepresentations.entries()) {
				const valid =
					representation === "boxed" ||
					representation === "number" ||
					representation === "boolean";
				if (!valid)
					fail("direct-entry register class is invalid", { ...context, register });
				const expected =
					register < fn.parameterCount
						? entry.parameterRepresentations[register]
						: fn.registerRepresentations[register];
				if (representation !== expected) {
					fail("direct entry changes a register outside its parameter contract", {
						...context,
						register,
					});
				}
			}
			if (entry.resultRepresentation !== coreDirectResultRepresentation(core)) {
				fail(
					"direct-entry result representation lacks a matching Core return proof",
					context,
				);
			}
			const signature = `${entry.parameterRepresentations.join(",")}->${entry.resultRepresentation}`;
			if (signatures.has(signature)) fail("duplicate direct-entry signature", context);
			signatures.add(signature);
			verifyExecutionFunctionRepresentationVariant(
				{
					...fn,
					registerRepresentations: entry.registerRepresentations,
					gc: entry.gc,
				},
				core,
				functionIndex,
			);
		}
	}

	for (const [functionIndex, fn] of program.functions.entries()) {
		for (const { instructions } of fn.blocks) {
			for (const instruction of instructions) {
				if (instruction.type !== "call") continue;
				const context = { functionIndex, opcode: instruction.type };
				if (instruction.directCallbackFunctionIndex !== undefined) {
					if (
						program.functions[instruction.directCallbackFunctionIndex] === undefined ||
						!ARRAY_ITERATION_CALLBACK_OPERATIONS.has(
							instruction.knownBuiltinCall?.operation ?? "",
						) ||
						instruction.registers.length < 4
					) {
						fail(
							"exact callback target is not attached to an Array callback call",
							context,
						);
					}
				}
				if (instruction.directEntryId === undefined) continue;
				const targetIndex = instruction.directFunctionIndex;
				if (targetIndex === undefined) {
					fail("direct-entry call has no exact function target", context);
				}
				const target = program.functions[targetIndex];
				const entry = target?.directEntries[instruction.directEntryId];
				if (entry === undefined || entry.id !== instruction.directEntryId) {
					fail("direct-entry call names an unknown target ABI", context);
				}
				for (const [parameter, expected] of entry.parameterRepresentations.entries()) {
					if (expected === "boxed") continue;
					const operand = parameter + 3;
					const register = instruction.registers[operand];
					const actual =
						register === undefined
							? "boxed"
							: register < 0
								? immediateRepresentation(instruction.immediateValues?.[operand])
								: fn.registerRepresentations[register];
					if (actual !== expected) {
						fail(
							"direct-entry call argument does not satisfy its transport class",
							context,
						);
					}
				}
			}
		}
	}
}
