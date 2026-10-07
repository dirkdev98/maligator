import { nativeValueConversion } from "./native-value-transport.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { vmExceptionHandlerTargets } from "./runtime-image.ts";

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

export function selectNativeDirectHeapObjects(
	native: NativeFunctionPlan,
): ReadonlyArray<number> {
	if (native.mode !== "direct") return [];
	const handlers = vmExceptionHandlerTargets(
		native.body.instructions.length,
		native.body.handlers,
	);
	const points = new Map(
		native.gc.safepoints.map((point) => [point.instructionIp, point]),
	);
	const allocations: Array<number> = [];
	for (const region of native.specializations) {
		if (region.kind !== "stack-object-plan") continue;
		for (const site of region.sites) {
			const allocation = native.body.instructions[site.allocationIp];
			const returnIp = site.allocationIp + 1;
			const returned = native.body.instructions[returnIp];
			const point = points.get(site.allocationIp);
			if (
				site.mode !== "activation-local" ||
				site.accesses.length !== 0 ||
				site.inheritedAccessIp !== undefined ||
				site.materializations.length !== 1 ||
				site.materializations[0]!.ip !== returnIp ||
				site.materializations[0]!.kind !== "return" ||
				allocation?.opcode !== "CREATE_OBJECT_SHAPED" ||
				returned?.opcode !== "RETURN" ||
				returned.value !== allocation.dst ||
				handlers[site.allocationIp] !== undefined ||
				handlers[returnIp] !== undefined ||
				point?.kind !== "operation" ||
				!point.outgoingRootRegisters.includes(allocation.dst) ||
				!allocation.valueRegisters.every((register) => {
					const rep = native.registerRepresentations[register];
					return (
						(rep !== "boxed" && rep !== "string") ||
						point.incomingRootRegisters.includes(register)
					);
				})
			)
				continue;
			// The same certificate requires a heap result before any subsequent observation.
			allocations.push(site.allocationIp);
		}
	}
	return allocations;
}

export function selectNativeStackObjectStorage(
	native: NativeFunctionPlan,
	directHeapObjects: ReadonlySet<number>,
): ReadonlyArray<NativeStackObjectStoragePlan> {
	if (native.mode !== "direct") return [];
	const plans: Array<NativeStackObjectStoragePlan> = [];
	for (const region of native.specializations) {
		if (region.kind !== "stack-object-plan") continue;
		for (const site of region.sites) {
			if (
				directHeapObjects.has(site.allocationIp) ||
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
