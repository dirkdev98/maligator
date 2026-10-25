import { COMPILER_VALUE_KIND_STRING } from "../shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../shared/instruction-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type {
	NativeControlFlowEntryOptions,
	NativeControlFlowPlan,
} from "./native-control-flow.ts";
import { createNativeStringLiteralQuery } from "./native-string-literals.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export interface NativeStringComparisonPlan {
	readonly instructionIp: number;
	readonly register: number;
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
	const comparisons = fn.instructions.flatMap((op, ip) =>
		op.opcode === "BINARY" &&
		(op.operator === "===" || op.operator === "!==") &&
		!options.elided.has(ip)
			? [{ op, ip }]
			: [],
	);
	if (
		comparisons.length === 0 ||
		!fn.instructions.some((op) => op.opcode === "CREATE_STRING")
	)
		return [];
	const unreachable =
		body.projection?.unreachable ?? new Set(options.controlFlow?.unreachableIps);
	const lengthAt = createNativeStringLiteralQuery(native, body, {
		...options,
		literalFact: options.stringLength,
	});
	return comparisons.flatMap(({ op, ip }) => {
		if (unreachable.has(ip)) return [];
		for (const register of [op.right, op.left]) {
			const length = lengthAt(ip, register);
			if (length !== undefined) {
				const other = register === op.right ? op.left : op.right;
				const knownString =
					native.registerRepresentations[other] === "string" ||
					instructionInputKind(native.facts?.[ip], other) === COMPILER_VALUE_KIND_STRING;
				return [
					{
						instructionIp: ip,
						register,
						length,
						kind: knownString ? ("strings" as const) : ("boxed" as const),
					},
				];
			}
		}
		return [];
	});
}
