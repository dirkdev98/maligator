/** Registers one emitted C function keeps in private root locals instead of continuous shadow slots. */
export function privateRootRegisters(source: string): ReadonlySet<number> {
	const registers = new Set<number>();
	for (const [, names] of source.matchAll(/^ {4}MalPrivateRoot ([^;]+);$/gm))
		for (const name of names!.split(", ")) {
			const register = /^(?:__private_)?r(\d+)$/.exec(name);
			if (register === null) throw new Error(`Unexpected private root '${name}'`);
			registers.add(Number(register[1]));
		}
	return registers;
}

function rootMaskWord(word: string): bigint {
	if (word === "UINT64_MAX") return (1n << 64n) - 1n;
	if (word === "0") return 0n;
	const hex = /^UINT64_C\((0x[\da-f]+)\)$/.exec(word);
	if (hex === null) throw new Error(`Unexpected root mask word '${word}'`);
	return BigInt(hex[1]!);
}

/** Inactive-slot bits of a narrow or row mask statement, resolved in one emitted C function. */
export function rootMaskBits(functionSource: string, statement: string): bigint {
	const narrow = /^MAL_ROOT_MASK\((0x[\da-f]+)\);?$/.exec(statement);
	if (narrow !== null) return BigInt(narrow[1]!);
	const row = /^MAL_ROOT_MASK_ROW\((\d+)\);?$/.exec(statement);
	if (row === null) throw new Error(`Unexpected root mask statement '${statement}'`);
	const tables = [
		...functionSource.matchAll(
			/static const u64 __gc_inactive_rows\[\]\[\d+\] = \{\n([\s\S]*?)\n {4}\};/g,
		),
	];
	if (tables.length !== 1)
		throw new Error(`Expected one root mask table, found ${tables.length}`);
	const words = /^ {8}\{ (.*) \},$/.exec(
		tables[0]![1]!.split("\n")[Number(row[1])] ?? "",
	);
	if (words === null) throw new Error(`Missing root mask row ${row[1]}`);
	return words[1]!
		.split(", ")
		.reduce((bits, word, index) => bits | (rootMaskWord(word) << BigInt(64 * index)), 0n);
}
