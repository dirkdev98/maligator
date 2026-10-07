import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export const NATIVE_CALL_CONVERSIONS = [
	"identity",
	"box-number",
	"box-int32",
	"box-boolean",
	"unbox-number",
	"unbox-int32",
	"unbox-boolean",
	"int32-to-number",
	"number-to-int32",
] as const;

export type NativeCallConversion = (typeof NATIVE_CALL_CONVERSIONS)[number];
export type NativeEntryLookup = ReadonlyMap<string, NativeDirectEntryPlan>;

export interface NativeCallTargetTransport {
	readonly functionIndex: number;
	readonly entryId: number;
	readonly arguments: ReadonlyArray<NativeCallConversion>;
	readonly resultRepresentation: VmRegisterRepresentation;
	readonly result: NativeCallConversion;
	readonly fields: ReadonlyArray<number>;
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

function conversion(
	source: VmRegisterRepresentation,
	target: VmRegisterRepresentation,
): NativeCallConversion | undefined {
	if (
		source === target ||
		((source === "boxed" || source === "string") &&
			(target === "boxed" || target === "string"))
	)
		return "identity";
	if (target === "boxed") {
		if (source === "number") return "box-number";
		if (source === "int32") return "box-int32";
		if (source === "boolean") return "box-boolean";
	}
	if (source === "boxed") {
		if (target === "number") return "unbox-number";
		if (target === "int32") return "unbox-int32";
		if (target === "boolean") return "unbox-boolean";
	}
	if (source === "int32" && target === "number") return "int32-to-number";
	if (source === "number" && target === "int32") return "number-to-int32";
	return undefined;
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
			const arguments_: Array<NativeCallConversion> = [];
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
				const mode = conversion(source, target);
				if (mode === undefined) break;
				arguments_.push(mode);
			}
			if (arguments_.length !== parameters.length) continue;
			const result = conversion(
				entry.resultRepresentation,
				native.registerRepresentations[op.dst]!,
			);
			if (result === undefined) continue;
			const allocation =
				fieldCall === undefined
					? undefined
					: native.body.instructions[fieldCall.allocationIp];
			const fields =
				entry.fieldParameters?.keys.map((key) =>
					allocation?.opcode === "CREATE_OBJECT_SHAPED"
						? allocation.keyStringIndices.indexOf(key)
						: -1,
				) ?? [];
			if (fields.some((field) => field < 0)) continue;
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
						target.fields.every((field, k) => field === other.fields[k])
					);
				})
			);
		})
	);
}
