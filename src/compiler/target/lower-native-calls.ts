import { nativeValueConversion } from "./native-value-transport.ts";
import type { NativeValueConversion } from "./native-value-transport.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export type NativeEntryLookup = ReadonlyMap<string, NativeDirectEntryPlan>;

export interface NativeCallTargetTransport {
	readonly functionIndex: number;
	readonly entryId: number;
	readonly arguments: ReadonlyArray<NativeValueConversion>;
	readonly resultRepresentation: VmRegisterRepresentation;
	readonly result: NativeValueConversion;
	readonly fields: ReadonlyArray<{
		readonly slot: number;
		readonly conversion: NativeValueConversion;
	}>;
}

export interface NativeCallTransportPlan {
	readonly instructionIp: number;
	readonly targets: ReadonlyArray<NativeCallTargetTransport>;
}

export function nativeEntryLookup(
	functions: ReadonlyArray<NativeFunctionPlan>,
): NativeEntryLookup {
	return new Map(
		functions.flatMap((fn) =>
			fn.directEntries.map(
				(entry) => [`${fn.functionIndex}:${entry.id}`, entry] as const,
			),
		),
	);
}

export function selectNativeCallTransports(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup,
): ReadonlyArray<NativeCallTransportPlan> {
	if (entries.size === 0) return [];
	const plans: Array<NativeCallTransportPlan> = [];
	const fieldCalls =
		native.fieldCalls === undefined
			? undefined
			: new Map(native.fieldCalls.map((site) => [site.callIp, site]));
	for (const [instructionIp, call] of native.instructions.entries()) {
		if (call?.kind !== "call" || call.directFunctionCall) continue;
		const fieldCall = fieldCalls?.get(instructionIp);
		if (call.directEntryId === undefined && fieldCall === undefined) continue;
		const op = native.body.instructions[instructionIp];
		if (op?.opcode !== "CALL") continue;
		const targets: Array<NativeCallTargetTransport> = [];
		for (const functionIndex of call.guardedFunctionIndices ??
			(call.directFunctionIndex === undefined ? [] : [call.directFunctionIndex])) {
			const fieldEntry = fieldCall?.entries.find(
				(entry) => entry.functionIndex === functionIndex,
			);
			const entryId =
				fieldEntry?.entryId ??
				((call.guardedFunctionIndices?.length ?? 1) === 1
					? call.directEntryId
					: undefined);
			if (entryId === undefined) continue;
			const entry = entries.get(`${functionIndex}:${entryId}`);
			if (entry === undefined) continue;
			const arguments_: Array<NativeValueConversion> = [];
			const parameters = entry.argumentRepresentations ?? entry.parameterRepresentations;
			for (const [parameter, target] of parameters.entries()) {
				const operand = op.arguments[parameter];
				if (operand === undefined) {
					if (target === "boxed") arguments_.push("identity");
					else break;
					continue;
				}
				const decoded = decodeVmValueOperand(operand);
				const source =
					decoded.kind === "register"
						? native.registerRepresentations[decoded.register]!
						: decoded.kind === "number"
							? "int32"
							: decoded.kind === "boolean" || decoded.kind === "string"
								? decoded.kind
								: "boxed";
				const mode = nativeValueConversion(source, target);
				if (mode === undefined) break;
				arguments_.push(mode);
			}
			if (arguments_.length !== parameters.length) continue;
			const result = nativeValueConversion(
				entry.resultRepresentation,
				native.registerRepresentations[op.dst]!,
			);
			if (result === undefined) continue;
			const allocation =
				fieldCall === undefined
					? undefined
					: native.body.instructions[fieldCall.allocationIp];
			const fields =
				entry.fieldParameters?.keys.flatMap((key, index) => {
					const slot =
						allocation?.opcode === "CREATE_OBJECT_SHAPED"
							? allocation.keyStringIndices.indexOf(key)
							: -1;
					const source = fieldCall?.valueRepresentations[slot];
					const target = entry.fieldParameters!.representations[index];
					const mode =
						source === undefined || target === undefined
							? undefined
							: nativeValueConversion(source, target);
					return slot < 0 || mode === undefined ? [] : [{ slot, conversion: mode }];
				}) ?? [];
			if (fields.length !== (entry.fieldParameters?.keys.length ?? 0)) continue;
			targets.push({
				functionIndex,
				entryId,
				arguments: arguments_,
				resultRepresentation: entry.resultRepresentation,
				result,
				fields,
			});
		}
		if (targets.length > 0) plans.push({ instructionIp, targets });
	}
	return plans;
}

export function nativeCallTransportsMatch(
	stored: ReadonlyArray<NativeCallTransportPlan>,
	selected: ReadonlyArray<NativeCallTransportPlan>,
): boolean {
	return (
		stored.length === selected.length &&
		stored.every((plan, i) => {
			const expected = selected[i]!;
			return (
				plan.instructionIp === expected.instructionIp &&
				plan.targets.length === expected.targets.length &&
				plan.targets.every((target, j) => {
					const other = expected.targets[j]!;
					return (
						target.functionIndex === other.functionIndex &&
						target.entryId === other.entryId &&
						target.resultRepresentation === other.resultRepresentation &&
						target.result === other.result &&
						target.arguments.length === other.arguments.length &&
						target.arguments.every((mode, k) => mode === other.arguments[k]) &&
						target.fields.length === other.fields.length &&
						target.fields.every(
							(field, k) =>
								field.slot === other.fields[k]?.slot &&
								field.conversion === other.fields[k]?.conversion,
						)
					);
				})
			);
		})
	);
}
