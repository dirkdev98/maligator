import type { BytecodeFunction } from "./runtime-image.ts";

/** UTF-16 offsets into the exact emitted C; positions belong to the runtime image. */
export interface NativeSourceRange {
	readonly start: number;
	readonly end: number;
	readonly positions: ReadonlyArray<number>;
	readonly precision: "statement" | "region" | "function";
}

export function shiftNativeSourceRanges(
	ranges: ReadonlyArray<NativeSourceRange>,
	offset: number,
): Array<NativeSourceRange> {
	return ranges.map((range) => ({
		...range,
		start: range.start + offset,
		end: range.end + offset,
	}));
}

export function nativeInstructionSourceRanges(
	fn: BytecodeFunction,
	lines: ReadonlyArray<string>,
	starts: ReadonlyArray<number>,
	ips: ReadonlyArray<number>,
	contributors: ReadonlyArray<ReadonlyArray<number>> = [],
): Array<NativeSourceRange> {
	const offsets = [0];
	for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
	const ranges: Array<NativeSourceRange> = [];
	for (const [unit, ip] of ips.entries()) {
		const start = offsets[starts[unit]!]!;
		const end = offsets[starts[unit + 1] ?? lines.length]! - 1;
		const extra = contributors[unit] ?? [];
		const positions = [
			...new Set([...fn.positions.slice(ip, ips[unit + 1] ?? ip + 1), ...extra]),
		].filter((position) => position >= 0);
		const precision = extra.length > 0 ? "region" : "statement";
		if (end <= start || positions.length === 0) continue;
		const previous = ranges.at(-1);
		if (
			previous !== undefined &&
			previous.end + 1 === start &&
			previous.precision === precision &&
			previous.positions.length === positions.length &&
			previous.positions.every((position, index) => position === positions[index])
		) {
			ranges[ranges.length - 1] = { ...previous, end };
		} else ranges.push({ start, end, positions, precision });
	}
	return ranges;
}
