function isIdentifierCodeUnit(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 95
	);
}

// Match the emitter's ASCII word boundaries even inside conservative string/comment references.
export function generatedDeclarationReferences(
	source: string,
	declarations: ReadonlyMap<string, ReadonlyArray<number>>,
): Array<number> {
	const referenced = new Set<number>();
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
		const indices = declarations.get(source.slice(start, end));
		if (indices !== undefined) for (const index of indices) referenced.add(index);
	}
	return [...referenced];
}
