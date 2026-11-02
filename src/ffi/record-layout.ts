import type { CRecordLayout } from "./c-model.ts";
import { FfiError } from "./ffi-error.ts";

/** Ambiguous scoped tags cannot identify a declaration from Clang's printed name. */
export function clangRecordLayouts(
	text: string,
): ReadonlyMap<string, CRecordLayout | null> {
	const layouts = new Map<string, CRecordLayout | null>();
	for (const block of text.split("*** Dumping AST Record Layout").slice(1)) {
		const match =
			/^\s*Type: (struct|union) (.+)\r?\n\s*Layout: <ASTRecordLayout\s+Size:(\d+)\s+DataSize:\d+\s+Alignment:(\d+)\s+FieldOffsets: \[([\d,\s]*)\]>/u.exec(
				block,
			);
		if (match === null) throw new FfiError("cannot decode Clang's C record layout");
		const spelling = match[2]!;
		const anonymous = /\((?:unnamed|anonymous) at .+\)$/u.exec(spelling)?.[0];
		const name =
			anonymous?.replace(/^\(anonymous at /u, "(unnamed at ") ??
			spelling.split("::").at(-1)!;
		const layout: CRecordLayout = {
			sizeBits: Number(match[3]),
			alignmentBits: Number(match[4]),
			fieldOffsetsBits: match[5]!.trim() === "" ? [] : match[5]!.split(",").map(Number),
		};
		if (
			![layout.sizeBits, layout.alignmentBits, ...layout.fieldOffsetsBits].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			) ||
			layout.alignmentBits === 0 ||
			layout.fieldOffsetsBits.some((offset) => offset > layout.sizeBits)
		)
			throw new FfiError(`invalid C record layout for ${match[1]} ${name}`);
		const key = `${match[1]} ${name}`;
		const previous = layouts.get(key);
		const same =
			previous !== undefined &&
			previous !== null &&
			previous.sizeBits === layout.sizeBits &&
			previous.alignmentBits === layout.alignmentBits &&
			previous.fieldOffsetsBits.length === layout.fieldOffsetsBits.length &&
			previous.fieldOffsetsBits.every(
				(offset, index) => offset === layout.fieldOffsetsBits[index],
			);
		layouts.set(key, previous === undefined || same ? layout : null);
	}
	return layouts;
}
