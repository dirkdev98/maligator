import type { BytecodeInstruction, RuntimeImage } from "./runtime-image.ts";

/** A property inline cache site of one image function, at its innermost source position. */
export interface FeedbackPropertySite {
	readonly op: "get" | "set";
	/** The static property name, or `*` for a computed key. */
	readonly key: string;
	/** The source file of the function the position lies in, after inlining. */
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

function propertySite(
	image: RuntimeImage,
	instruction: BytecodeInstruction,
): Pick<FeedbackPropertySite, "op" | "key"> | undefined {
	const named = (stringIndex: number) =>
		String.fromCodePoint(...(image.stringConstants[stringIndex] ?? []));
	switch (instruction.opcode) {
		case "LOAD_PROPERTY":
			return { op: "get", key: "*" };
		case "LOAD_PROPERTY_STATIC":
		case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH":
		case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
		case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
			return { op: "get", key: named(instruction.stringIndex) };
		case "PROBE_READ":
			return instruction.stringIndex === undefined
				? undefined
				: { op: "get", key: named(instruction.stringIndex) };
		case "STORE_PROPERTY":
			return { op: "set", key: "*" };
		case "STORE_PROPERTY_STATIC":
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return { op: "set", key: named(instruction.stringIndex) };
		default:
			return undefined;
	}
}

/**
 * Map each function's property IC indices to source sites. A site inlined from
 * another function belongs to that function's source, as the inline chain of its
 * position says, so feedback recorded in a caller's caches lands on the callee.
 * Sites without a source position are omitted.
 */
export function feedbackPropertySites(
	image: RuntimeImage,
): Array<ReadonlyMap<number, FeedbackPropertySite>> {
	return image.functions.map((fn, functionIndex) => {
		const sites = new Map<number, FeedbackPropertySite>();
		for (const [ip, instruction] of fn.instructions.entries()) {
			if (!("icIndex" in instruction) || sites.has(instruction.icIndex)) continue;
			const site = propertySite(image, instruction);
			const positionId = fn.positions[ip] ?? -1;
			const position = image.sourcePositions[positionId];
			if (site === undefined || positionId < 0 || position === undefined) continue;
			const leaf = image.functions[position.inlinedFunctionIndex ?? functionIndex];
			const file = leaf === undefined ? undefined : image.files[leaf.fileIndex];
			if (file === undefined) continue;
			sites.set(instruction.icIndex, {
				...site,
				file,
				line: position.line,
				column: position.column,
			});
		}
		return sites;
	});
}
