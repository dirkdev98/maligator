/**
 * The TypeScript declarations of the generated Unicode tables. They decode on first
 * use, because loading a compiler module must not pay for tables that only
 * compile-time Unicode folding reads.
 */
export function unicodeTablesModule(
	data: Readonly<Record<string, ReadonlyArray<number | string>>>,
): Array<string> {
	return [
		"export interface UnicodeTables {",
		...Object.keys(data).map((name) => `\t${name}: Uint32Array;`),
		"}",
		"let tables: UnicodeTables | undefined;",
		"/** Decoded on the first call, which costs a few milliseconds. */",
		"export function unicodeTables(): UnicodeTables {",
		"\treturn (tables ??= {",
		...Object.entries(data).map(
			([name, values]) => `\t\t${name}: decode("${values.join(",")}"),`,
		),
		"\t});",
		"}",
		"// Packed text keeps generated data out of the compiler's per-element IR.",
		"function decode(packed: string): Uint32Array {",
		'\treturn new Uint32Array(packed.split(",").map(Number));',
		"}",
	];
}
