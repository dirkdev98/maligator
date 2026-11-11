import { COMPILER_VALUE_KIND_BIGINT } from "../shared/compiler-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/**
 * A wrapping BigInt chain computes in 64 bits because its only consumer reads the
 * result modulo 2^64. These operators keep that sound: each result's low 64 bits
 * depend only on the operands' low 64 bits, in two's complement for negative values.
 */
const WRAP_OPERATORS: ReadonlySet<string> = new Set(["+", "-", "*", "&", "|", "^"]);

// A Number conversion of a smaller mask is exact.
const MASK_LIMIT = 1n << 53n;

/** How a wrapping chain's single consumer reads its value. */
export type CoreBigIntWrapFinish =
	| { readonly kind: "width"; readonly bits: number; readonly signed: boolean }
	| { readonly kind: "number" };

function operand(fn: CoreFunctionStore, instruction: CoreInstructionId, index: number) {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const owner = fn.kernel.valueDefinitionOwner(value) as CoreInstructionId;
	return fn.instructionKind(owner) === "operation" ? owner : undefined;
}

function numberConstant(fn: CoreFunctionStore, value: CoreValueId): number | undefined {
	const owner = definition(fn, value);
	if (
		owner === undefined ||
		!["createNumber", "createF64", "createI32"].includes(fn.instructionOpcodeName(owner))
	)
		return undefined;
	const immediate = fn.instructionAttributes(owner).value;
	return typeof immediate === "number" ? immediate : undefined;
}

function bigintConstant(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
): bigint | undefined {
	const owner = definition(fn, value);
	if (owner === undefined || fn.instructionOpcodeName(owner) !== "createBigint")
		return undefined;
	const index = fn.instructionAttributes(owner).bigintIndex;
	return typeof index === "number" ? program.bigintConstants[index] : undefined;
}

export function coreBigIntWrapOperator(operator: unknown): operator is string {
	return typeof operator === "string" && WRAP_OPERATORS.has(operator);
}

/** Whether a binary operation can be computed modulo 2^64 inside a wrapping chain. */
export function coreBigIntWrapNode(
	fn: CoreFunctionStore,
	kinds: CoreValueKindAnalysis,
	instruction: CoreInstructionId,
): boolean {
	const operator = fn.instructionAttributes(instruction).operator;
	return (
		fn.instructionKind(instruction) === "operation" &&
		fn.instructionOpcodeName(instruction) === "binary" &&
		coreBigIntWrapOperator(operator) &&
		fn.kernel.instructionOperandCount(instruction) === 2 &&
		[0, 1].every(
			(index) =>
				kinds.kindMask(operand(fn, instruction, index)) === COMPILER_VALUE_KIND_BIGINT,
		)
	);
}

/**
 * The consumer `finish` of the chain whose last node `last` produces `value`:
 * `BigInt.asUintN`/`asIntN` with a constant width of at most 64, or `Number` of a
 * mask with a non-negative constant below 2^53, whose value is exactly its low bits.
 */
export function coreBigIntWrapFinish(
	program: CoreProgram,
	fn: CoreFunctionStore,
	last: CoreInstructionId,
	finish: CoreInstructionId,
	value: CoreValueId,
): CoreBigIntWrapFinish | undefined {
	if (
		fn.instructionKind(finish) !== "operation" ||
		fn.instructionOpcodeName(finish) !== "callKnown"
	)
		return undefined;
	const attributes = fn.instructionAttributes(finish);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	const count = fn.kernel.instructionOperandCount(finish);
	if (
		attributes.operation === "BigInt.asUintN" ||
		attributes.operation === "BigInt.asIntN"
	) {
		const bits = count === 3 ? numberConstant(fn, operand(fn, finish, 1)) : undefined;
		return bits !== undefined &&
			Number.isInteger(bits) &&
			bits >= 1 &&
			bits <= 64 &&
			operand(fn, finish, 2) === value
			? { kind: "width", bits, signed: attributes.operation === "BigInt.asIntN" }
			: undefined;
	}
	if (attributes.operation !== "Number" || count < 2 || operand(fn, finish, 1) !== value)
		return undefined;
	if (fn.instructionAttributes(last).operator !== "&") return undefined;
	const mask = [0, 1]
		.map((index) => bigintConstant(program, fn, operand(fn, last, index)))
		.find(
			(constant) => constant !== undefined && constant >= 0n && constant < MASK_LIMIT,
		);
	return mask === undefined ? undefined : { kind: "number" };
}
