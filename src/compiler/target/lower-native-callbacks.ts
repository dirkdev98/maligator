import { builtinOperationDescriptor } from "../shared/builtin-registry.ts";
import type { NativeEntryLookup } from "./lower-native-calls.ts";
import type { NativeFunctionPlan, VmRegisterRepresentation } from "./program-image.ts";

export interface NativeCallbackTransportPlan {
	readonly instructionIp: number;
	readonly functionIndex: number;
	readonly entryId: number;
	readonly argumentCount?: number;
	readonly parameters: ReadonlyArray<VmRegisterRepresentation>;
	readonly resultRepresentation: VmRegisterRepresentation;
}

export function selectNativeCallbackTransports(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup,
): ReadonlyArray<NativeCallbackTransportPlan> {
	if (entries.size === 0) return [];
	const claimed = new Set(native.specializations.flatMap((region) => region.claimedIps));
	for (const action of native.regionActions) claimed.add(action.ip);
	return native.instructions.flatMap((call, instructionIp) => {
		if (
			claimed.has(instructionIp) ||
			call?.kind !== "call" ||
			call.directFunctionCall ||
			call.directCallbackFunctionIndex === undefined
		)
			return [];
		const invocation = builtinOperationDescriptor(
			call.guardedBuiltinCall?.operation ?? "",
		)?.callback;
		const arity = invocation?.argumentKinds.length;
		if (arity === undefined || native.body.instructions[instructionIp]?.opcode !== "CALL")
			return [];
		const functionIndex = call.directCallbackFunctionIndex;
		let selected: NativeCallbackTransportPlan | undefined;
		let selectedScore = 0;
		for (let entryId = 0; ; entryId++) {
			const entry = entries.get(`${functionIndex}:${entryId}`);
			if (entry === undefined) break;
			if (
				entry.fieldParameters !== undefined ||
				(entry.argumentRepresentations !== undefined &&
					entry.argumentRepresentations.length !== arity)
			)
				continue;
			const parameters = entry.argumentRepresentations ?? entry.parameterRepresentations;
			if (parameters.some((rep, index) => index >= arity && rep !== "boxed")) continue;
			const score =
				parameters.filter((rep) => rep !== "boxed").length * (arity + 1) +
				parameters.filter(
					(rep, index) =>
						rep === "number" && invocation!.argumentKinds[index] === "number",
				).length;
			if (score <= selectedScore) continue;
			selectedScore = score;
			selected = {
				instructionIp,
				functionIndex,
				entryId,
				...(entry.argumentRepresentations === undefined
					? {}
					: { argumentCount: entry.argumentRepresentations.length }),
				parameters,
				resultRepresentation: entry.resultRepresentation,
			};
		}
		return selected === undefined ? [] : [selected];
	});
}

export function nativeCallbackTransportsMatch(
	stored: ReadonlyArray<NativeCallbackTransportPlan>,
	selected: ReadonlyArray<NativeCallbackTransportPlan>,
): boolean {
	return (
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			return (
				plan.instructionIp === expected.instructionIp &&
				plan.functionIndex === expected.functionIndex &&
				plan.entryId === expected.entryId &&
				plan.argumentCount === expected.argumentCount &&
				plan.resultRepresentation === expected.resultRepresentation &&
				plan.parameters.length === expected.parameters.length &&
				plan.parameters.every((rep, i) => rep === expected.parameters[i])
			);
		})
	);
}
