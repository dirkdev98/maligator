import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";

export function boxSwitchLocals(image: ProgramImage): ProgramImage {
	return lowerNativeStorage(
		{
			...image,
			native: {
				...image.native,
				functions: image.native.functions.map((fn) => {
					const selectors = new Set(
						(fn.literalSwitches ?? []).map((site) => site.selector),
					);
					const box = (
						representation: (typeof fn.registerRepresentations)[number],
						register: number,
					) =>
						register >= fn.body.parameterCount && selectors.has(register)
							? ("boxed" as const)
							: representation;
					return {
						...fn,
						registerRepresentations: fn.registerRepresentations.map(box),
						directEntries: fn.directEntries.map((entry) => ({
							...entry,
							registerRepresentations: entry.registerRepresentations.map(box),
						})),
					};
				}),
			},
		},
		"precise",
	);
}
