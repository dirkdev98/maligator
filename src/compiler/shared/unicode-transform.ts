import {
	unicodeCased,
	unicodeClasses,
	unicodeComposition,
	unicodeDecomposition,
	unicodeIgnorable,
	unicodeLower,
	unicodePool,
	unicodeSoftDotted,
	unicodeUpper,
} from "./unicode-data.ts";

function row(table: Uint32Array, stride: number, cp: number): number {
	let low = 0,
		high = table.length / stride;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (table[middle * stride]! < cp) low = middle + 1;
		else high = middle;
	}
	return table[low * stride] === cp ? low * stride : -1;
}
function property(table: Uint32Array, cp: number): boolean {
	let low = 0,
		high = table.length / 2;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (table[middle * 2 + 1]! < cp) low = middle + 1;
		else high = middle;
	}
	return low * 2 < table.length && table[low * 2]! <= cp;
}
function combiningClass(cp: number): number {
	const index = row(unicodeClasses, 2, cp);
	return index < 0 ? 0 : unicodeClasses[index + 1]!;
}
function composite(first: number, second: number): number | undefined {
	if (first >= 0x1100 && first < 0x1113 && second >= 0x1161 && second < 0x1176)
		return 0xac00 + ((first - 0x1100) * 21 + second - 0x1161) * 28;
	if (
		first >= 0xac00 &&
		first < 0xd7a4 &&
		(first - 0xac00) % 28 === 0 &&
		second > 0x11a7 &&
		second < 0x11c3
	)
		return first + second - 0x11a7;
	let low = 0,
		high = unicodeComposition.length / 3;
	while (low < high) {
		const middle = (low + high) >>> 1,
			index = middle * 3;
		if (
			unicodeComposition[index]! < first ||
			(unicodeComposition[index] === first && unicodeComposition[index + 1]! < second)
		)
			low = middle + 1;
		else high = middle;
	}
	const index = low * 3;
	return unicodeComposition[index] === first && unicodeComposition[index + 1] === second
		? unicodeComposition[index + 2]
		: undefined;
}

export interface UnicodeTransformResult {
	readonly value: string;
	readonly work: number;
}

export function transformUnicodeCase(
	source: string,
	upper: boolean,
	locale: "und" | "tr" | "az" | "lt" = "und",
	workLimit = 4096,
): UnicodeTransformResult | undefined {
	if (source.length > workLimit) return undefined;
	const points = Array.from(source, (character) => character.codePointAt(0)!);
	let work = source.length,
		value = "";
	function context(
		index: number,
		direction: -1 | 1,
		accept: (cp: number) => boolean,
		skip: (cp: number) => boolean,
	): boolean {
		for (
			let cursor = index + direction;
			cursor >= 0 && cursor < points.length;
			cursor += direction
		) {
			if (++work > workLimit) return false;
			const cp = points[cursor]!;
			if (skip(cp)) continue;
			return accept(cp);
		}
		return false;
	}
	const table = upper ? unicodeUpper : unicodeLower;
	for (let index = 0; index < points.length; index++) {
		const cp = points[index]!;
		let mapped: ReadonlyArray<number> | Uint32Array | undefined;
		if (
			!upper &&
			cp === 0x3a3 &&
			context(
				index,
				-1,
				(cp) => property(unicodeCased, cp),
				(cp) => property(unicodeIgnorable, cp),
			) &&
			!context(
				index,
				1,
				(cp) => property(unicodeCased, cp),
				(cp) => property(unicodeIgnorable, cp),
			)
		)
			mapped = [0x3c2];
		if (locale === "tr" || locale === "az") {
			if (upper && cp === 0x69) mapped = [0x130];
			else if (!upper && cp === 0x130) mapped = [0x69];
			else if (
				!upper &&
				cp === 0x307 &&
				context(
					index,
					-1,
					(cp) => cp === 0x49,
					(cp) => combiningClass(cp) !== 0 && combiningClass(cp) !== 230,
				)
			)
				mapped = [];
			else if (
				!upper &&
				cp === 0x49 &&
				!context(
					index,
					1,
					(cp) => cp === 0x307,
					(cp) => cp !== 0x307 && combiningClass(cp) !== 0 && combiningClass(cp) !== 230,
				)
			)
				mapped = [0x131];
		} else if (locale === "lt") {
			if (
				upper &&
				cp === 0x307 &&
				context(
					index,
					-1,
					(cp) => property(unicodeSoftDotted, cp),
					(cp) => combiningClass(cp) !== 0 && combiningClass(cp) !== 230,
				)
			)
				mapped = [];
			else if (
				!upper &&
				(cp === 0x49 || cp === 0x4a || cp === 0x12e) &&
				context(
					index,
					1,
					(cp) => combiningClass(cp) === 230,
					(cp) => combiningClass(cp) !== 0 && combiningClass(cp) !== 230,
				)
			)
				mapped = [cp === 0x12e ? 0x12f : cp + 32, 0x307];
			else if (!upper && (cp === 0xcc || cp === 0xcd || cp === 0x128))
				mapped = [0x69, 0x307, cp === 0xcc ? 0x300 : cp === 0xcd ? 0x301 : 0x303];
		}
		if (mapped === undefined) {
			const found = row(table, 3, cp);
			mapped =
				found < 0
					? [cp]
					: unicodePool.subarray(table[found + 1], table[found + 1]! + table[found + 2]!);
		}
		for (const scalar of mapped) {
			work += scalar > 0xffff ? 2 : 1;
			if (work > workLimit) return undefined;
			value += String.fromCodePoint(scalar);
		}
		if (work > workLimit) return undefined;
	}
	return { value, work };
}

export function normalizeUnicode(
	source: string,
	form: "NFC" | "NFD" | "NFKC" | "NFKD",
	workLimit = 4096,
): UnicodeTransformResult | undefined {
	if (source.length > workLimit) return undefined;
	const points: Array<number> = [];
	let work = source.length;
	const compatibility = form === "NFKC" || form === "NFKD";
	function decompose(cp: number): boolean {
		if (++work > workLimit) return false;
		if (cp >= 0xac00 && cp < 0xd7a4) {
			const syllable = cp - 0xac00;
			points.push(
				0x1100 + Math.floor(syllable / 588),
				0x1161 + Math.floor((syllable % 588) / 28),
			);
			if (syllable % 28 !== 0) points.push(0x11a7 + (syllable % 28));
			return true;
		}
		const found = row(unicodeDecomposition, 4, cp);
		if (found < 0 || (!compatibility && unicodeDecomposition[found + 3] !== 0)) {
			points.push(cp);
			return true;
		}
		const start = unicodeDecomposition[found + 1]!,
			end = start + unicodeDecomposition[found + 2]!;
		for (let index = start; index < end; index++)
			if (!decompose(unicodePool[index]!)) return false;
		return true;
	}
	for (const character of source)
		if (!decompose(character.codePointAt(0)!)) return undefined;
	for (let index = 1; index < points.length; index++) {
		const cp = points[index]!,
			currentClass = combiningClass(cp);
		if (currentClass === 0) continue;
		let cursor = index;
		while (cursor > 0) {
			if (++work > workLimit) return undefined;
			const previousClass = combiningClass(points[cursor - 1]!);
			if (previousClass <= currentClass) break;
			points[cursor] = points[cursor - 1]!;
			cursor--;
		}
		points[cursor] = cp;
	}
	if (form === "NFC" || form === "NFKC") {
		let length = 0,
			starter = -1,
			previousClass = 0;
		for (const cp of points) {
			if (++work > workLimit) return undefined;
			const currentClass = combiningClass(cp);
			const combined =
				starter >= 0 && (previousClass === 0 || previousClass < currentClass)
					? composite(points[starter]!, cp)
					: undefined;
			if (combined !== undefined) points[starter] = combined;
			else {
				if (currentClass === 0) starter = length;
				points[length++] = cp;
				previousClass = currentClass;
			}
		}
		points.length = length;
	}
	let value = "";
	for (const cp of points) {
		work += cp > 0xffff ? 2 : 1;
		if (work > workLimit) return undefined;
		value += String.fromCodePoint(cp);
	}
	return { value, work };
}
