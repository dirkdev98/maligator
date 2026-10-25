import {
	COMPILER_VALUE_KIND_NUMBER,
	compilerValueKindTruthiness,
} from "../shared/compiler-value-kinds.ts";
import {
	compilerIntegerRangeTruthiness,
	compilerIntegerRangeComparison,
} from "../shared/integer-range.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreValueKindObservation } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreInstructionRangeQuery } from "./core-native-instruction-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export function coreNativeEntryReachableBlocks(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	kinds: CoreValueKindAnalysis,
	constants: ReadonlyArray<{
		readonly instruction: CoreInstructionId;
		readonly value: boolean;
	}>,
	range: CoreInstructionRangeQuery,
): ReadonlySet<CoreBlockId> {
	const fixed = new Map(constants.map(({ instruction, value }) => [instruction, value]));
	// Consumer-local ranges cannot become globally cached facts about an SSA value.
	const memo = new Map<CoreValueId, boolean | undefined>();
	const truth = (input: CoreValueId): boolean | undefined => {
		const chain: Array<{ value: CoreValueId; negate: boolean }> = [];
		const active = new Set<CoreValueId>();
		let value = input;
		let result: boolean | undefined;
		for (;;) {
			if (memo.has(value)) {
				result = memo.get(value);
				break;
			}
			result = compilerValueKindTruthiness(kinds.kindMask(value));
			if (
				result !== undefined ||
				active.has(value) ||
				fn.kernel.valueDefinitionKind(value) !== 1
			)
				break;
			active.add(value);
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			if (opcode === "move" || (opcode === "unary" && attributes.operator === "!")) {
				const input = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				if (kinds.kindMask(input) === COMPILER_VALUE_KIND_NUMBER) {
					const known = compilerIntegerRangeTruthiness(
						range(input, fn.instructionBlock(instruction)),
					);
					if (known !== undefined) {
						result = opcode === "unary" ? !known : known;
						break;
					}
				}
				chain.push({ value, negate: opcode === "unary" });
				value = input;
				continue;
			}
			result =
				fixed.get(instruction) ??
				coreValueKindObservation(
					program,
					fn,
					instruction,
					(operand) => kinds.kindMask(operand),
					(operand, consumer) => range(operand, fn.instructionBlock(consumer)),
				);
			if (
				result === undefined &&
				opcode === "binary" &&
				typeof attributes.operator === "string" &&
				["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(attributes.operator)
			) {
				const start = fn.kernel.instructionOperandStart(instruction);
				const block = fn.instructionBlock(instruction);
				const left = fn.kernel.operandAt(start),
					right = fn.kernel.operandAt(start + 1);
				if (
					kinds.kindMask(left) === COMPILER_VALUE_KIND_NUMBER &&
					kinds.kindMask(right) === COMPILER_VALUE_KIND_NUMBER
				)
					result = compilerIntegerRangeComparison(
						attributes.operator,
						range(left, block),
						range(right, block),
					);
			}
			if (result !== undefined) break;
			if (opcode === "createBoolean") result = attributes.value as boolean;
			else if (opcode === "createNumber" || opcode === "createF64")
				result = attributes.value !== 0 && !Number.isNaN(attributes.value);
			else if (opcode === "createString") {
				const units = program.stringConstants[attributes.stringIndex as number];
				if (units !== undefined) result = units.length !== 0;
			}
			break;
		}
		memo.set(value, result);
		for (const item of chain.reverse()) {
			if (item.negate && result !== undefined) result = !result;
			memo.set(item.value, result);
		}
		return result;
	};
	const reachable = new Set<CoreBlockId>();
	const pending = [fn.entry];
	// Handler entry contracts survive independently of ordinary branch pruning.
	for (let index = 0; index < fn.handlerBlockCount; index++) {
		const handler = fn.kernel.blockHandlerBlock(fn.handlerBlockAt(index));
		if (handler !== undefined) pending.push(handler);
	}
	while (pending.length > 0) {
		const block = pending.pop()!;
		if (reachable.has(block)) continue;
		reachable.add(block);
		const terminator = fn.blockTerminator(block);
		let target: CoreBlockId | undefined;
		if (fn.instructionKind(terminator) === "branch") {
			const condition = fn.kernel.operandAt(
				fn.kernel.instructionOperandStart(terminator),
			);
			const decision =
				truth(condition) ??
				(kinds.kindMask(condition) === COMPILER_VALUE_KIND_NUMBER
					? compilerIntegerRangeTruthiness(range(condition, block))
					: undefined);
			if (decision !== undefined)
				target = fn.kernel.terminatorEdgeBlock(
					fn.kernel.terminatorEdgeStart(terminator) + (decision ? 0 : 1),
				);
		}
		for (const edge of cfg.successors[block] ?? [])
			if (target === undefined || edge.kind === "exceptional" || edge.to === target)
				pending.push(edge.to);
	}
	return reachable;
}
