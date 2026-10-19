import { vmExceptionHandlerTargets } from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

export interface NativeCaptureAccessPlan {
	readonly ownsEnvironment: boolean;
	readonly owners: ReadonlyArray<{
		readonly ownerFunctionIndex: number;
		readonly lookupIndex: number;
	}>;
	readonly copiedValues: NonNullable<BytecodeFunction["closureCaptureValues"]>;
	readonly initialization: "lookup" | "complete-layout";
	readonly layout: ReadonlyArray<number>;
	readonly fallback: "owner-lookup";
}

export function selectNativeCaptureAccess(
	fn: BytecodeFunction,
	functionIndex: number,
): NativeCaptureAccessPlan {
	const copiedValues =
		fn.strict && !fn.isGenerator && !fn.isAsync && fn.capturedCount === 0
			? (fn.closureCaptureValues ?? [])
			: [];
	const copies = new Set(
		copiedValues.map((value) => `${value.ownerFunctionIndex}:${value.capturedIndex}`),
	);
	const owners = new Set<number>();
	let ownsEnvironment = fn.capturedCount > 0;
	for (const instruction of fn.instructions) {
		if (
			(instruction.opcode === "LOAD_CAPTURED" ||
				instruction.opcode === "STORE_CAPTURED") &&
			instruction.ownerFunctionIndex >= 0 &&
			instruction.ownerFunctionIndex !== functionIndex &&
			!(
				instruction.opcode === "LOAD_CAPTURED" &&
				copies.has(`${instruction.ownerFunctionIndex}:${instruction.index}`)
			)
		)
			owners.add(instruction.ownerFunctionIndex);
		if (
			["ENV_PUSH", "ENV_COPY", "ENV_POP", "WITH_ENTER", "WITH_EXIT"].includes(
				instruction.opcode,
			)
		)
			ownsEnvironment = false;
	}
	const layout = fn.closureCaptureOwners;
	const completeLayout =
		owners.size > 0 &&
		layout !== undefined &&
		layout.length <= 16 &&
		!fn.isGenerator &&
		!fn.isAsync &&
		[...owners].every((owner) => layout.includes(owner));
	return {
		ownsEnvironment,
		owners: [...owners]
			.sort((a, b) => a - b)
			.map((ownerFunctionIndex) => ({
				ownerFunctionIndex,
				lookupIndex: layout?.indexOf(ownerFunctionIndex) ?? -1,
			})),
		copiedValues,
		initialization: completeLayout ? "complete-layout" : "lookup",
		layout: completeLayout ? layout : [],
		fallback: "owner-lookup",
	};
}

export function nativeCaptureAccessPlansMatch(
	stored: NativeCaptureAccessPlan | undefined,
	selected: NativeCaptureAccessPlan,
): boolean {
	return (
		stored !== undefined &&
		stored.ownsEnvironment === selected.ownsEnvironment &&
		stored.initialization === selected.initialization &&
		stored.fallback === selected.fallback &&
		stored.layout.length === selected.layout.length &&
		stored.layout.every((owner, index) => owner === selected.layout[index]) &&
		stored.owners.length === selected.owners.length &&
		stored.owners.every((owner, index) => {
			const expected = selected.owners[index]!;
			return (
				owner.ownerFunctionIndex === expected.ownerFunctionIndex &&
				owner.lookupIndex === expected.lookupIndex
			);
		}) &&
		stored.copiedValues.length === selected.copiedValues.length &&
		stored.copiedValues.every((value, index) => {
			const expected = selected.copiedValues[index]!;
			return (
				value.ownerFunctionIndex === expected.ownerFunctionIndex &&
				value.capturedIndex === expected.capturedIndex
			);
		})
	);
}

/**
 * Where an activation that owns its capture environment may run before creating it.
 * Until an instruction needs the environment object, captured slots live in rooted
 * frame slots, so calls that return before creating a closure allocate nothing.
 */
export interface NativeLazyCaptureEnvironment {
	/** Per instruction: ENVIRONMENT_ABSENT and/or ENVIRONMENT_PRESENT on arrival. */
	readonly states: Uint8Array;
	/** Some instruction can arrive in both states and must test a runtime flag. */
	readonly guarded: boolean;
}

export const ENVIRONMENT_ABSENT = 1;
export const ENVIRONMENT_PRESENT = 2;

export function needsCaptureEnvironmentObject(instruction: BytecodeInstruction): boolean {
	return (
		instruction.opcode === "CREATE_FUNCTION" ||
		instruction.opcode === "CREATE_PRIVATE_NAMES"
	);
}

export function planLazyCaptureEnvironment(
	fn: BytecodeFunction,
	captures: NativeCaptureAccessPlan,
): NativeLazyCaptureEnvironment | undefined {
	if (
		fn.capturedCount === 0 ||
		!captures.ownsEnvironment ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.mappedArguments
	)
		return undefined;
	const count = fn.instructions.length;
	const handlers =
		fn.handlers.length === 0 ? [] : vmExceptionHandlerTargets(count, fn.handlers);
	const successors = (ip: number): Array<number> => {
		const instruction = fn.instructions[ip]!;
		const handler = handlers[ip];
		const exceptional = handler === undefined ? [] : [handler];
		switch (instruction.opcode) {
			case "JUMP":
				return [instruction.targetIp, ...exceptional];
			case "JUMP_IF":
				return [instruction.targetIp, ip + 1, ...exceptional];
			case "RETURN":
			case "THROW":
			case "LOAD_UNDECLARED":
				return exceptional;
			default:
				return [ip + 1, ...exceptional];
		}
	};
	const states = new Uint8Array(count);
	const walk = (pending: Array<number>, state: number, stopAtCreation: boolean) => {
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip < 0 || ip >= count || (states[ip]! & state) !== 0) continue;
			states[ip]! |= state;
			if (stopAtCreation && needsCaptureEnvironmentObject(fn.instructions[ip]!)) continue;
			pending.push(...successors(ip));
		}
	};
	walk([0], ENVIRONMENT_ABSENT, true);
	const returnsWithout = fn.instructions.some(
		(instruction, ip) =>
			instruction.opcode === "RETURN" && (states[ip]! & ENVIRONMENT_ABSENT) !== 0,
	);
	if (!returnsWithout) return undefined;
	const created: Array<number> = [];
	for (const [ip, instruction] of fn.instructions.entries())
		if (
			(states[ip]! & ENVIRONMENT_ABSENT) !== 0 &&
			needsCaptureEnvironmentObject(instruction)
		)
			created.push(...successors(ip));
	walk(created, ENVIRONMENT_PRESENT, false);
	return {
		states,
		guarded: states.some((state) => state === (ENVIRONMENT_ABSENT | ENVIRONMENT_PRESENT)),
	};
}
