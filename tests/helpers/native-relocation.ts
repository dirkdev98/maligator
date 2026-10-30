import { splitEmissionSymbolStems } from "../../src/compiler/target/emit-program-image.ts";
import type { GeneratedTranslationUnit } from "../../src/compiler/target/emit-program-image.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import type {
	CompiledFunction,
	NativeRelocatableEmission,
} from "../../src/compiler/target/render-native-c.ts";

export const TEST_RELOCATION: NativeRelocatableEmission = {
	symbolStem: "overlay",
	relocation: "&vm->compiler_native_relocation",
};

/** Rewrites link-table reads to the overlay-local index each slot holds. */
export function resolveNativeLinks(
	emitted: Pick<CompiledFunction, "symbol" | "source" | "link">,
): string {
	const link = emitted.link ?? [];
	const read = new RegExp(
		String.raw`\(__mal_relocation->(\w+) \+ ${emitted.symbol}_link\[(\d+)\]\)`,
		"g",
	);
	return emitted.source.replace(read, (_match, base: string, slot: string) => {
		const entry = link[Number(slot)];
		if (entry?.base !== base)
			throw new Error(`${emitted.symbol} reads ${base} through link slot ${slot}`);
		return `(__mal_relocation->${base} + ${String(entry.index)})`;
	});
}

/** Joins overlay units with each code unit's link reads replaced by the defined indices. */
export function resolveOverlayUnitLinks(sources: ReadonlyArray<string>): string {
	const links = new Map<string, Array<string>>();
	for (const source of sources)
		for (const [, symbol, values] of source.matchAll(
			/^const i32 (\w+) ?\[\] = \{ ([^}]*) \};$/gm,
		))
			links.set(symbol!, values!.split(", "));
	return sources
		.join("\n")
		.replace(
			/\(__mal_relocation->(\w+) \+ (\w+)\[(\d+)\]\)/g,
			(match, base: string, symbol: string, slot: string) => {
				const value = links.get(symbol)?.[Number(slot)];
				if (value === undefined) throw new Error(`${match} reads an undefined link slot`);
				return `(__mal_relocation->${base} + ${value})`;
			},
		);
}

/**
 * Split whole-program units as their image indices name them: each link read becomes
 * the index its table defines, and each function's symbol stem becomes its index.
 */
export function resolveSplitUnitLinks(
	image: ProgramImage,
	sources: ReadonlyArray<string>,
): Array<string> {
	const links = new Map<string, Array<string>>();
	for (const source of sources)
		for (const [, symbol, values] of source.matchAll(
			/^const i32 (\w+_link) ?\[\] = \{ ([^}]*) \};$/gm,
		))
			links.set(symbol!, values!.split(", "));
	const functionIndices = new Map(
		splitEmissionSymbolStems(image).map((stem, index) => [stem, String(index)]),
	);
	return sources.map((source) =>
		source
			.replace(/\b(\w+_link)\[(\d+)\]/g, (match, symbol: string, slot: string) => {
				const value = links.get(symbol)?.[Number(slot)];
				if (value === undefined) throw new Error(`${match} reads an undefined link slot`);
				return value;
			})
			.replace(/[0-9a-f]{16}/g, (stem) => functionIndices.get(stem) ?? stem),
	);
}

/** The function index each split-emission compiled symbol names. */
export function splitSymbolFunctionIndex(
	image: ProgramImage,
	symbol: string,
): number | undefined {
	const match = /^mal_(?:compiled_([0-9a-f]{16})|direct_([0-9a-f]{16})_\d+)$/.exec(
		symbol,
	);
	const stem = match?.[1] ?? match?.[2];
	if (stem === undefined) return undefined;
	const index = splitEmissionSymbolStems(image).indexOf(stem);
	return index < 0 ? undefined : index;
}

/** Split units whose sources and definition symbols name functions by image index. */
export function resolveSplitUnits(
	image: ProgramImage,
	units: ReadonlyArray<GeneratedTranslationUnit>,
): Array<GeneratedTranslationUnit> {
	const sources = resolveSplitUnitLinks(
		image,
		units.map((unit) => unit.sourceChunks.join("")),
	);
	const [named = ""] = resolveSplitUnitLinks(image, [
		units.flatMap((unit) => unit.definitions.map((item) => item.symbol)).join("\n"),
	]);
	const symbols = named.split("\n");
	let next = 0;
	return units.map((unit, index) => ({
		...unit,
		sourceChunks: [sources[index]!],
		sourceCodeUnits: sources[index]!.length,
		definitions: unit.definitions.map((item) => ({ ...item, symbol: symbols[next++]! })),
	}));
}
