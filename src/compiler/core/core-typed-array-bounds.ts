import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import type { CoreLocalFactBundle } from "./core-ir-provenance.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreContainedTypedArrayIndexInBounds(
	program: CoreProgram,
	fn: CoreFunctionStore,
	facts: CoreLocalFactBundle,
	loops: CoreLoopInductionAnalysis,
	instruction: CoreInstructionId,
): boolean {
	const root = (value: CoreValueId) => facts.roots.get(value) ?? value;
	const operand = (id: CoreInstructionId, index: number) =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(id) + index);
	const definition = (value: CoreValueId) =>
		fn.kernel.valueDefinitionKind(root(value)) === 1
			? coreInstructionId(fn.kernel.valueDefinitionOwner(root(value)))
			: undefined;
	const number = (value: CoreValueId): number | undefined => {
		const id = definition(value);
		if (
			id === undefined ||
			!["createNumber", "createF64"].includes(fn.instructionOpcodeName(id))
		)
			return undefined;
		const value_ = fn.instructionAttributes(id).value;
		return typeof value_ === "number" ? value_ : undefined;
	};
	const receiver = root(operand(instruction, 0));
	if (
		facts.valueClasses.containedFixedNumericTypedArray(receiver, instruction) ===
		undefined
	)
		return false;
	const index = operand(instruction, 1);
	const block = coreBlockId(fn.kernel.instructionBlock(instruction));
	const allocation = definition(receiver);
	const extent =
		allocation !== undefined &&
		fn.instructionOpcodeName(allocation) === "construct" &&
		fn.kernel.instructionOperandCount(allocation) === 2
			? number(operand(allocation, 1))
			: undefined;
	const range = loops.range(index, block);
	if (
		extent !== undefined &&
		Number.isFinite(extent) &&
		extent >= 0 &&
		extent <= 0xffff_ffff &&
		range !== undefined &&
		range.minimum >= 0 &&
		range.maximum < Math.floor(extent)
	)
		return true;
	const induction = loops.induction(index);
	if (
		induction === undefined ||
		induction.representation !== "f64" ||
		induction.step !== 1 ||
		number(induction.initial) !== 0 ||
		!induction.loop.blocks.has(block)
	)
		return false;
	const comparison = induction.comparison;
	if (
		comparison === undefined ||
		comparison.operator !== "<" ||
		!facts.control.dominates(comparison.body, block)
	)
		return false;
	const bound = definition(comparison.bound);
	if (
		bound === undefined ||
		fn.instructionOpcodeName(bound) !== "loadPropertyStatic" ||
		root(operand(bound, 0)) !== receiver
	)
		return false;
	const stringIndex = fn.instructionAttributes(bound).stringIndex;
	const key =
		typeof stringIndex === "number" ? program.stringConstants[stringIndex] : undefined;
	return (
		key?.length === 6 &&
		key[0] === 108 &&
		key[1] === 101 &&
		key[2] === 110 &&
		key[3] === 103 &&
		key[4] === 116 &&
		key[5] === 104
	);
}
