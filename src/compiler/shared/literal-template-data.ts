export interface LiteralTemplateReference {
	readonly position: number;
	readonly index: number;
}

export interface LiteralTemplateSegment {
	readonly endOffset: number;
	readonly stringReferences: ReadonlyArray<LiteralTemplateReference>;
	readonly bigintReferences: ReadonlyArray<LiteralTemplateReference>;
}

export function validateStaticQueryTemplate(
	data: ReadonlyArray<number>,
	offset: number,
	kind: "includes" | "has-own",
): LiteralTemplateSegment {
	const segment = scanLiteralTemplateSegment(data, offset, "static query");
	if (data[offset] !== 8) throw new RangeError("static query requires an array payload");
	let position = offset + 2;
	for (let index = 0; index < data[offset + 1]!; index++) {
		const tag = data[position++]!;
		if ((tag >= 8 && tag !== 11) || (kind === "has-own" && tag !== 5))
			throw new RangeError("static query requires primitive data or own string keys");
		position += tag === 4 ? 2 : tag === 3 || tag === 5 || tag === 6 ? 1 : 0;
	}
	return segment;
}

export function copyLiteralTemplateData(data: ReadonlyArray<number>): Array<number> {
	const copy = new Array<number>(data.length);
	for (let index = 0; index < data.length; index++) copy[index] = data[index]!;
	return copy;
}

/** Scan one encoded literal-template root and return its exact pool references. */
export function scanLiteralTemplateSegment(
	data: ReadonlyArray<number>,
	offset: number,
	owner: string,
): LiteralTemplateSegment {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) {
		throw new Error(`${owner} names unknown offset ${offset}`);
	}
	let position = offset;
	const stringReferences: Array<LiteralTemplateReference> = [];
	const bigintReferences: Array<LiteralTemplateReference> = [];
	const actions: Array<"node" | "property"> = ["node"];
	const take = (where: string): number => {
		if (position >= data.length) throw new Error(`Truncated ${owner} ${where}`);
		return data[position++]!;
	};
	const takeCount = (where: string): number => {
		const count = take(where);
		if (!Number.isSafeInteger(count) || count < 0 || count > data.length) {
			throw new Error(`Invalid ${owner} ${where} ${count}`);
		}
		return count;
	};
	while (actions.length > 0) {
		const action = actions.pop()!;
		if (action === "property") {
			const tag = take("object key tag");
			if (tag !== 10) throw new Error(`Unknown ${owner} object tag ${tag}`);
			const referencePosition = position;
			stringReferences.push({
				position: referencePosition,
				index: take("object key"),
			});
			actions.push("node");
			continue;
		}
		const tag = take("node");
		switch (tag) {
			case 0:
			case 1:
			case 2:
			case 7:
			case 11:
				break;
			case 3:
				take("integer");
				break;
			case 4:
				take("number low word");
				take("number high word");
				break;
			case 5: {
				const referencePosition = position;
				stringReferences.push({
					position: referencePosition,
					index: take("string"),
				});
				break;
			}
			case 6: {
				const referencePosition = position;
				bigintReferences.push({
					position: referencePosition,
					index: take("bigint"),
				});
				break;
			}
			case 8: {
				const count = takeCount("array length");
				for (let index = 0; index < count; index++) actions.push("node");
				break;
			}
			case 9: {
				const count = takeCount("object size");
				for (let index = 0; index < count; index++) actions.push("property");
				break;
			}
			default:
				throw new Error(`Unknown ${owner} tag ${tag}`);
		}
	}
	return { endOffset: position, stringReferences, bigintReferences };
}

export function compactLiteralTemplateSegments(
	data: ReadonlyArray<number>,
	liveOffsets: ReadonlySet<number>,
	owner: string,
	visit: {
		readonly string: (index: number, segmentOffset: number) => void;
		readonly bigint: (index: number, segmentOffset: number) => void;
	},
): {
	readonly data: ReadonlyArray<number>;
	readonly oldToNew: ReadonlyMap<number, number>;
} {
	const compacted: Array<number> = [];
	const oldToNew = new Map<number, number>();
	const canonicalOffsets = new Map<string, number>();
	for (const offset of [...liveOffsets].sort((left, right) => left - right)) {
		const segment = scanLiteralTemplateSegment(data, offset, owner);
		for (const reference of segment.stringReferences) {
			visit.string(reference.index, offset);
		}
		for (const reference of segment.bigintReferences) {
			visit.bigint(reference.index, offset);
		}
		const words = data.slice(offset, segment.endOffset);
		const key = words.join(",");
		const canonicalOffset = canonicalOffsets.get(key);
		if (canonicalOffset !== undefined) {
			oldToNew.set(offset, canonicalOffset);
			continue;
		}
		oldToNew.set(offset, compacted.length);
		canonicalOffsets.set(key, compacted.length);
		for (let index = 0; index < words.length; index++) compacted.push(words[index]!);
	}
	return { data: compacted, oldToNew };
}

export function remapLiteralTemplateConstants(
	data: ReadonlyArray<number>,
	segmentOffsets: ReadonlyArray<number>,
	owner: string,
	remapString: (index: number) => number,
	remapBigint: (index: number) => number,
): Array<number> {
	const remapped = copyLiteralTemplateData(data);
	for (const offset of segmentOffsets) {
		const segment = scanLiteralTemplateSegment(data, offset, owner);
		for (const reference of segment.stringReferences) {
			remapped[reference.position] = remapString(reference.index);
		}
		for (const reference of segment.bigintReferences) {
			remapped[reference.position] = remapBigint(reference.index);
		}
	}
	return remapped;
}
