// Partition identities hash UTF-16 code units with optional literal self-symbol normalization.
export function stablePartitionHash(
	value: string,
	round: number,
	prefix = "",
	selfSymbol?: string,
): number {
	if (selfSymbol === "") throw new RangeError("partition self symbol must be nonempty");
	let hash = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
	const append = (text: string, start: number, end: number) => {
		for (let index = start; index < end; index++) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	};
	append(prefix, 0, prefix.length);
	if (selfSymbol === undefined) append(value, 0, value.length);
	else {
		let start = 0;
		for (;;) {
			const found = value.indexOf(selfSymbol, start);
			if (found < 0) {
				append(value, start, value.length);
				break;
			}
			append(value, start, found);
			append("<self>", 0, 6);
			start = found + selfSymbol.length;
		}
	}
	return hash;
}
