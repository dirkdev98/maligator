import { nativeValueConversion } from "./native-value-transport.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export type NativeStackFieldRepresentation =
	| "int32"
	| "number"
	| "boolean"
	| "boxed"
	| "string";

export interface NativeStackObjectStoragePlan {
	readonly allocationIp: number;
	readonly slotRepresentations: ReadonlyArray<NativeStackFieldRepresentation>;
}

export function selectNativeStackObjectStorage(
	native: NativeFunctionPlan,
): ReadonlyArray<NativeStackObjectStoragePlan> {
	if (native.mode !== "direct") return [];
	const plans: Array<NativeStackObjectStoragePlan> = [];
	for (const region of native.specializations) {
		if (region.kind !== "stack-object-plan") continue;
		for (const site of region.sites) {
			if (
				site.mode === "elided" ||
				site.slotCount === 0 ||
				site.inheritedAccessIp !== undefined ||
				!site.materializations.every(
					(materialization) =>
						materialization.kind === "return" &&
						native.body.instructions[materialization.ip]?.opcode === "RETURN",
				)
			)
				continue;
			const allocation = native.body.instructions[site.allocationIp];
			if (allocation?.opcode !== "CREATE_OBJECT_SHAPED") continue;
			const reps = allocation.valueRegisters.map(
				(register) => native.registerRepresentations[register],
			);
			if (
				reps.length !== site.slotCount ||
				!reps.every(
					(rep): rep is NativeStackFieldRepresentation =>
						rep === "int32" ||
						rep === "number" ||
						rep === "boolean" ||
						rep === "boxed" ||
						rep === "string",
				) ||
				!reps.some((rep) => rep === "int32" || rep === "number" || rep === "boolean")
			)
				continue;
			let valid = true;
			for (const access of site.accesses) {
				const op = native.body.instructions[access.ip];
				if (access.slot < 0 || access.slot >= reps.length) {
					valid = false;
					break;
				}
				if (
					op?.opcode === "STORE_PROPERTY_STATIC" ||
					op?.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
				) {
					const source = native.registerRepresentations[op.value];
					const current = reps[access.slot]!;
					if (source === undefined) {
						valid = false;
						break;
					}
					if (source !== current)
						reps[access.slot] =
							(source === "int32" || source === "number") &&
							(current === "int32" || current === "number")
								? "number"
								: "boxed";
				} else if (
					op?.opcode !== "LOAD_PROPERTY_STATIC" &&
					op?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
				) {
					valid = false;
					break;
				}
			}
			if (
				!valid ||
				!reps.some((rep) => rep === "int32" || rep === "number" || rep === "boolean")
			)
				continue;
			if (
				!site.accesses.every((access) => {
					const op = native.body.instructions[access.ip]!;
					if (
						op.opcode === "LOAD_PROPERTY_STATIC" ||
						op.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
					)
						return (
							nativeValueConversion(
								reps[access.slot]!,
								native.registerRepresentations[op.dst]!,
							) !== undefined
						);
					if (
						op.opcode === "STORE_PROPERTY_STATIC" ||
						op.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
					)
						return (
							nativeValueConversion(
								native.registerRepresentations[op.value]!,
								reps[access.slot]!,
							) !== undefined
						);
					return false;
				})
			)
				continue;

			plans.push({ allocationIp: site.allocationIp, slotRepresentations: reps });
		}
	}
	return plans;
}
