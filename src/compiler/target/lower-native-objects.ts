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
		if (region.kind !== "stack-object-plan" || region.license.materialization !== "none")
			continue;
		for (const site of region.sites) {
			if (
				site.mode === "elided" ||
				site.slotCount === 0 ||
				site.inheritedAccessIp !== undefined ||
				site.materializations.length !== 0
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
			if (
				!site.accesses.every((access) => {
					const op = native.body.instructions[access.ip];
					const register =
						op?.opcode === "LOAD_PROPERTY_STATIC" ||
						op?.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
							? op.dst
							: op?.opcode === "STORE_PROPERTY_STATIC" ||
								  op?.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
								? op.value
								: undefined;
					return (
						register !== undefined &&
						access.slot >= 0 &&
						access.slot < reps.length &&
						native.registerRepresentations[register] === reps[access.slot]
					);
				})
			)
				continue;
			plans.push({ allocationIp: site.allocationIp, slotRepresentations: reps });
		}
	}
	return plans;
}
