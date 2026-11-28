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

/** A source position in the file of the function it lies in, after inlining. */
export interface FeedbackSourcePosition {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	/** Whether the position lies in an inlined copy of another function. */
	readonly inlined: boolean;
}

function sourcePosition(
	image: RuntimeImage,
	functionIndex: number,
	ip: number,
): FeedbackSourcePosition | undefined {
	return sourcePositionById(
		image,
		functionIndex,
		image.functions[functionIndex]?.positions[ip] ?? -1,
	);
}

function sourcePositionById(
	image: RuntimeImage,
	functionIndex: number,
	positionId: number,
): FeedbackSourcePosition | undefined {
	const position = image.sourcePositions[positionId];
	if (positionId < 0 || position === undefined) return undefined;
	const leaf = image.functions[position.inlinedFunctionIndex ?? functionIndex];
	const file = leaf === undefined ? undefined : image.files[leaf.fileIndex];
	if (file === undefined) return undefined;
	return {
		file,
		line: position.line,
		column: position.column,
		inlined: position.inlinedFunctionIndex !== undefined,
	};
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
			const position = sourcePosition(image, functionIndex, ip);
			if (site === undefined || position === undefined) continue;
			sites.set(instruction.icIndex, {
				...site,
				file: position.file,
				line: position.line,
				column: position.column,
			});
		}
		return sites;
	});
}

const CALL_OPCODES: ReadonlySet<string> = new Set([
	"CALL",
	"CALL_SPREAD",
	"CALL_SPREAD_ITERABLE",
]);

/**
 * Map each function's call instructions, the ones the interpreter records the
 * callees of, to their innermost source position, as property sites are mapped.
 * Calls are keyed by source position id: loading drops instructions, such as
 * jumps to the next one, so a runtime instruction index names no wire instruction.
 */
export function feedbackCallSites(
	image: RuntimeImage,
): Array<ReadonlyMap<number, FeedbackSourcePosition>> {
	return image.functions.map((fn, functionIndex) => {
		const sites = new Map<number, FeedbackSourcePosition>();
		for (const [ip, instruction] of fn.instructions.entries()) {
			const positionId = fn.positions[ip] ?? -1;
			if (!CALL_OPCODES.has(instruction.opcode) || sites.has(positionId)) continue;
			const position = sourcePositionById(image, functionIndex, positionId);
			if (position !== undefined) sites.set(positionId, position);
		}
		return sites;
	});
}

/**
 * Where a function's source is found: a position of its own code, outside
 * inlined copies, or for a function without one, such as `(value) => value * 2`,
 * the position of the instruction creating it with its ordinal among the
 * creations at that position, which follow source order.
 */
export type FeedbackFunctionSource =
	| { readonly kind: "own"; readonly position: FeedbackSourcePosition }
	| {
			readonly kind: "created";
			readonly position: FeedbackSourcePosition;
			readonly ordinal: number;
	  };

export function feedbackFunctionSources(
	image: RuntimeImage,
): Array<FeedbackFunctionSource | undefined> {
	const sources: Array<FeedbackFunctionSource | undefined> = image.functions.map(
		(fn, functionIndex) => {
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				const position = sourcePosition(image, functionIndex, ip);
				if (position !== undefined && !position.inlined) return { kind: "own", position };
			}
			return undefined;
		},
	);
	for (const [functionIndex, fn] of image.functions.entries()) {
		const ordinals = new Map<number, number>();
		for (const [ip, instruction] of fn.instructions.entries()) {
			if (instruction.opcode !== "CREATE_FUNCTION") continue;
			const positionId = fn.positions[ip] ?? -1;
			const ordinal = ordinals.get(positionId) ?? 0;
			ordinals.set(positionId, ordinal + 1);
			const position = sourcePositionById(image, functionIndex, positionId);
			if (sources[instruction.functionIndex] !== undefined || position === undefined)
				continue;
			sources[instruction.functionIndex] = {
				kind: "created",
				position,
				ordinal,
			};
		}
	}
	return sources;
}
