import type { BytecodeFunction } from "./runtime-image.ts";

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
