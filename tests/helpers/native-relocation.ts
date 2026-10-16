import type {
	CompiledFunction,
	NativeRelocatableEmission,
} from "../../src/compiler/target/render-native-c.ts";

export const TEST_RELOCATION: NativeRelocatableEmission = { symbolStem: "overlay" };

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
