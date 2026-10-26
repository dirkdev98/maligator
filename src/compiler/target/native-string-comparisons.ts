import { COMPILER_VALUE_KIND_STRING } from "../shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../shared/instruction-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type {
	NativeControlFlowEntryOptions,
	NativeControlFlowPlan,
} from "./native-control-flow.ts";
import { createNativeStringLiteralQuery } from "./native-string-literals.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export interface NativeStringComparisonPlan {
	readonly instructionIp: number;
	readonly operand: number;
	readonly length: number;
	readonly kind: "boxed" | "strings";
}

export function selectNativeStringComparisons(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	options: NativeControlFlowEntryOptions & {
		readonly controlFlow?: NativeControlFlowPlan;
		readonly elided: ReadonlySet<number>;
		readonly stringLength: (index: number) => number | undefined;
		readonly workLimit?: number;
	},
): ReadonlyArray<NativeStringComparisonPlan> {
	const fn = native.body;
	const comparisons: Array<{ ip: number; left: number; right: number }> = [];
	for (const [ip, op] of fn.instructions.entries()) {
		if (options.elided.has(ip)) continue;
		if (op.opcode === "BINARY" && (op.operator === "===" || op.operator === "!==")) {
			comparisons.push({ ip, left: op.left, right: op.right });
			continue;
		}
		const plan = native.instructions[ip];
		if (
			(op.opcode === "CALL_KNOWN" &&
				op.operation === "Object.is" &&
				!op.construct &&
				op.argumentMode === undefined &&
				(op.specialized === undefined || op.specialized === op.operation)) ||
			(op.opcode === "CALL" &&
				plan?.kind === "call" &&
				plan.guardedBuiltinCall?.operation === "Object.is")
		) {
			if (op.argumentCount < 2) continue;
			const [left, right] = op.arguments;
			if (left !== undefined && right !== undefined)
				comparisons.push({ ip, left, right });
		}
	}
	if (comparisons.length === 0) return [];
	const unreachable =
		body.projection?.unreachable ?? new Set(options.controlFlow?.unreachableIps);
	const hasLiterals = fn.instructions.some((op) => op.opcode === "CREATE_STRING");
	let literalAt: ReturnType<typeof createNativeStringLiteralQuery> | undefined;
	const lengthAt = (ip: number, operand: number): number | undefined => {
		if (operand < 0) {
			const decoded = decodeVmValueOperand(operand);
			return decoded.kind === "string" ? options.stringLength(decoded.index) : undefined;
		}
		if (!hasLiterals) return undefined;
		literalAt ??= createNativeStringLiteralQuery(native, body, {
			...options,
			literalFact: options.stringLength,
		});
		return literalAt(ip, operand);
	};
	return comparisons.flatMap(({ left, right, ip }) => {
		if (unreachable.has(ip)) return [];
		for (const operand of [right, left]) {
			const length = lengthAt(ip, operand);
			if (length !== undefined) {
				const other = operand === right ? left : right;
				const otherKind = instructionInputKind(native.facts?.[ip], other);
				const representation = native.registerRepresentations[other];
				if (
					(other < 0 && decodeVmValueOperand(other).kind !== "string") ||
					(otherKind !== undefined && (otherKind & COMPILER_VALUE_KIND_STRING) === 0) ||
					representation === "int32" ||
					representation === "number" ||
					representation === "boolean"
				)
					return [];
				const knownString =
					other < 0
						? decodeVmValueOperand(other).kind === "string"
						: representation === "string" || otherKind === COMPILER_VALUE_KIND_STRING;
				return [
					{
						instructionIp: ip,
						operand,
						length,
						kind: knownString ? ("strings" as const) : ("boxed" as const),
					},
				];
			}
		}
		return [];
	});
}

export function nativeStringComparisonExpression(
	plan: NativeStringComparisonPlan | undefined,
	leftOperand: number,
	left: string,
	right: string,
): string | undefined {
	if (plan === undefined) return undefined;
	const constant = plan.operand === leftOperand ? left : right;
	const other = plan.operand === leftOperand ? right : left;
	return plan.kind === "strings"
		? `mal_string_equals_constant_length(mal_value_to_string(${other}), mal_value_to_string(${constant}), ${plan.length})`
		: `mal_ops_strict_equal_string_constant(${other}, ${constant}, ${plan.length})`;
}
