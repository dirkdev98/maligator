import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
} from "../shared/compiler-value-kinds.ts";
import { joinEffectSummaries } from "../shared/effect-summary.ts";
import type { EffectSummary } from "../shared/effect-summary.ts";
import type { HostInvocationContract } from "../shared/host-invocation-contracts.ts";
import { CORE_NATIVE_INVOCATION_ATTRIBUTE } from "./core-internal-attributes.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

export interface CoreNativeInvocation {
	readonly firstInput: number;
	readonly body: EffectSummary;
	readonly allocatesOnSuccess: boolean;
	readonly retains?: ReadonlyArray<number>;
	readonly mutates?: ReadonlyArray<number>;
	readonly returns?: "primitive" | "fresh" | number;
}

export function instantiateNativeInvocation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	contract: HostInvocationContract | undefined,
	locked: boolean,
	mask: (value: CoreValueId) => number | undefined,
): CoreNativeInvocation | undefined {
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		contract === undefined ||
		!("body" in contract) ||
		(contract.lockedPrimordials && !locked) ||
		(contract.form === "getter"
			? opcode !== "loadPropertyStatic" && opcode !== "loadProperty"
			: opcode !== (contract.form ?? "call")) ||
		fn.instructionAttributes(instruction).argumentMode !== undefined
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const count = fn.kernel.instructionOperandCount(instruction);
	const firstInput = contract.form === "getter" ? 0 : 1;
	const firstArgument = contract.form === undefined ? 2 : 1;
	const maskAt = (index: number) =>
		index + firstArgument < count
			? (mask(fn.kernel.operandAt(start + index + firstArgument)) ??
				COMPILER_VALUE_KIND_TOP)
			: COMPILER_VALUE_KIND_UNDEFINED;
	const requirement = contract.requires;
	if (requirement === "primitive-arguments") {
		for (let index = 0; index + firstArgument < count; index++)
			if ((maskAt(index) & COMPILER_VALUE_KIND_OBJECT) !== 0) return undefined;
	} else if (
		requirement !== undefined &&
		!requirement.every((expected, index) =>
			compilerValueKindMaskIsSubset(maskAt(index), expected),
		)
	)
		return undefined;
	const body = contract.body;
	const index = (role: "receiver" | number) =>
		role === "receiver" ? firstInput : role + firstArgument;
	const positions = (roles: ReadonlyArray<"receiver" | number> | undefined) =>
		roles?.map(index).filter((offset) => offset < count);
	const returns =
		body.returns === "receiver" || typeof body.returns === "number"
			? index(body.returns)
			: body.returns;
	return {
		firstInput,
		body: body.effects,
		allocatesOnSuccess: body.allocatesOnSuccess,
		retains: positions(body.retains),
		mutates: positions(body.mutates),
		returns: typeof returns === "number" && returns >= count ? undefined : returns,
	};
}

export function coreNativeInvocation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreNativeInvocation | undefined {
	return fn.kernel.instructionAttributes(instruction)[
		CORE_NATIVE_INVOCATION_ATTRIBUTE
	] as CoreNativeInvocation | undefined;
}

const completeEffects = new WeakMap<
	CoreNativeInvocation,
	{ readonly bridge: EffectSummary; readonly effects: EffectSummary }
>();

export function coreNativeInvocationEffects(
	invocation: CoreNativeInvocation,
	bridge: EffectSummary,
): EffectSummary {
	const prior = completeEffects.get(invocation);
	if (prior?.bridge === bridge) return prior.effects;
	// The return poll can preempt into a different fiber under a custom C host.
	// The native body still cannot publish an argument that it only borrows.
	const effects = joinEffectSummaries(bridge, invocation.body);
	completeEffects.set(invocation, { bridge, effects });
	return effects;
}

export function coreNativeInvocationPreservesOperand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	operand: number,
): boolean {
	const invocation = coreNativeInvocation(fn, instruction);
	return (
		invocation !== undefined &&
		operand >= invocation.firstInput &&
		invocation.returns !== operand &&
		invocation.retains?.includes(operand) !== true &&
		invocation.mutates?.includes(operand) !== true
	);
}
