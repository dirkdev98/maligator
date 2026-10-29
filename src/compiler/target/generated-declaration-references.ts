function isIdentifierCodeUnit(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 95
	);
}

// Match the emitter's ASCII word boundaries even inside conservative string/comment references.
export function generatedDeclarationSymbols(source: string): Set<string> {
	const referenced = new Set<string>();
	let cursor = 0;
	while (cursor < source.length) {
		const start = source.indexOf("mal_", cursor);
		if (start < 0) break;
		cursor = start + 4;
		if (start > 0 && isIdentifierCodeUnit(source.charCodeAt(start - 1))) continue;
		let end = cursor;
		while (isIdentifierCodeUnit(source.charCodeAt(end))) end++;
		if (end === cursor) continue;
		cursor = end;
		referenced.add(source.slice(start, end));
	}
	return referenced;
}

export function generatedDeclarationIndices(
	symbols: Iterable<string>,
	declarations: ReadonlyMap<string, ReadonlyArray<number>>,
): Array<number> {
	const referenced = new Set<number>();
	for (const symbol of symbols)
		for (const index of declarations.get(symbol) ?? []) referenced.add(index);
	return [...referenced];
}

export function generatedDeclarationReferences(
	source: string,
	declarations: ReadonlyMap<string, ReadonlyArray<number>>,
): Array<number> {
	return generatedDeclarationIndices(generatedDeclarationSymbols(source), declarations);
}
