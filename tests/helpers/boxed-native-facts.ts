import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../../src/compiler/target/program-image.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";

// Widening storage preserves the original facts; conservative roots cover every boxed register.
export function boxedNativeFactContract(image: ProgramImage): ProgramImage {
	const conservative = createConservativeNativePlan(
		image.native.functions.map((fn) => fn.body),
		image.runtime.stringConstants,
	);
	return lowerNativeStorage(
		{
			...image,
			native: {
				...conservative,
				functions: conservative.functions.map((fn, index) => ({
					...fn,
					facts: image.native.functions[index]!.facts,
					storageValues: image.native.functions[index]!.storageValues,
					instructions: fn.instructions.map((_, ip) => {
						const plan = image.native.functions[index]!.instructions[ip];
						return plan?.kind === "exact-contained-array-element" ||
							plan?.kind === "exact-array-element" ||
							plan?.kind === "exact-typed-array-element" ||
							plan?.kind === "contained-fixed-typed-array-element"
							? plan
							: undefined;
					}),
				})),
			},
		},
		"precise",
	);
}
