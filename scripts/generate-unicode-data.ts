import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "oxfmt";
import { unicodeTablesModule } from "./unicode-tables-module.ts";

const sources: Readonly<Record<string, string>> = {
	"UnicodeData.txt": "0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950",
	"SpecialCasing.txt": "8538dea57c184f1ef3783885ea79677b10f6efa06423717157e63712f14d1ad2",
	"DerivedCoreProperties.txt":
		"09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9",
	"CompositionExclusions.txt":
		"c759b100e9ae8960ae6b50fc5765950a7581fd9f30d4ef95f68f25a6d97e818e",
	"PropList.txt": "f438f532e8737bb8a2702126cdf9c4af5e357c58c7acf9d9eb2fc7c1a1d955d6",
};
const input = process.argv[2];
const output = process.argv[3];
if (!input || !output)
	throw new Error(
		"Usage: node scripts/generate-unicode-data.ts <Unicode-18.0.0-directory> <output-directory>",
	);
function rows(name: string): Array<Array<string>> {
	const bytes = readFileSync(resolve(input!, name));
	if (createHash("sha256").update(bytes).digest("hex") !== sources[name])
		throw new Error(`Unicode 18.0.0 source mismatch: ${name}`);
	return bytes
		.toString("utf8")
		.split(/\r?\n/)
		.map((line) => line.split("#")[0]!.trim())
		.filter(Boolean)
		.map((line) => line.split(";").map((field) => field.trim()));
}
const scalarList = (field: string) =>
	field === "" ? [] : field.split(/\s+/).map((cp) => Number.parseInt(cp, 16));
const lower = new Map<number, Array<number>>(),
	upper = new Map<number, Array<number>>();
const decomposition = new Map<
	number,
	{ values: Array<number>; compatibility: boolean }
>();
const classes = new Map<number, number>();
for (const row of rows("UnicodeData.txt")) {
	const cp = Number.parseInt(row[0]!, 16);
	if (row[12]) upper.set(cp, scalarList(row[12]));
	if (row[13]) lower.set(cp, scalarList(row[13]));
	if (row[3] !== "0") classes.set(cp, Number(row[3]));
	if (row[5])
		decomposition.set(cp, {
			values: scalarList(row[5].replace(/^<[^>]+>\s*/, "")),
			compatibility: row[5][0] === "<",
		});
}
const conditions = new Set<string>();
for (const row of rows("SpecialCasing.txt")) {
	if (row[4]) {
		conditions.add(row[4]);
		continue;
	}
	const cp = Number.parseInt(row[0]!, 16);
	lower.set(cp, scalarList(row[1]!));
	upper.set(cp, scalarList(row[3]!));
}
const expectedConditions = [
	"Final_Sigma",
	"lt After_Soft_Dotted",
	"lt More_Above",
	"lt",
	"tr",
	"az",
	"tr After_I",
	"az After_I",
	"tr Not_Before_Dot",
	"az Not_Before_Dot",
].sort();
if (JSON.stringify([...conditions].sort()) !== JSON.stringify(expectedConditions))
	throw new Error("Update the contextual case algorithms for changed UCD conditions");
const pool: Array<number> = [];
const mappings = (map: Map<number, Array<number>>) =>
	[...map]
		.filter(([cp, values]) => values.length !== 1 || values[0] !== cp)
		.sort(([a], [b]) => a - b)
		.flatMap(([cp, values]) => {
			const start = pool.length;
			pool.push(...values);
			return [cp, start, values.length];
		});
const data: Record<string, Array<number>> = {};
data.lower = mappings(lower);
data.upper = mappings(upper);
data.decomposition = [...decomposition]
	.sort(([a], [b]) => a - b)
	.flatMap(([cp, entry]) => {
		const start = pool.length;
		pool.push(...entry.values);
		return [cp, start, entry.values.length, Number(entry.compatibility)];
	});
data.classes = [...classes].sort(([a], [b]) => a - b).flat();
const classValues = new Uint8Array(0x110000);
const lastClass = Math.max(...classes.keys());
const caseClassValues = new Uint8Array((lastClass >> 2) + 1);
for (const [cp, value] of classes) {
	if (!Number.isInteger(value) || value < 0 || value > 255)
		throw new Error("Combining class exceeds u8");
	classValues[cp] = value;
	caseClassValues[cp >> 2]! |= (value === 230 ? 2 : 1) << ((cp & 3) * 2);
}
function deduplicateBlocks(values: Uint8Array, size: number, table: string) {
	const indices: Array<number> = [];
	const blocks: Array<number> = [];
	const ids = new Map<string, number>();
	for (let offset = 0; offset < values.length; offset += size) {
		const block = new Uint8Array(size);
		block.set(values.subarray(offset, offset + size));
		const key = block.join(",");
		let id = ids.get(key);
		if (id === undefined) {
			id = ids.size;
			if (id > 255) throw new Error(`${table} block index exceeds u8`);
			ids.set(key, id);
			blocks.push(...block);
		}
		indices.push(id);
	}
	return { indices, blocks };
}
const normalizationClassBits = 5;
const normalizationClasses = deduplicateBlocks(
	classValues.subarray(0, lastClass + 1),
	1 << normalizationClassBits,
	"Combining class",
);
const excluded = new Set(
	rows("CompositionExclusions.txt").map((row) => Number.parseInt(row[0]!, 16)),
);
data.composition = [...decomposition]
	.filter(
		([cp, entry]) =>
			!entry.compatibility &&
			entry.values.length === 2 &&
			!excluded.has(cp) &&
			!classes.has(entry.values[0]!),
	)
	.map(([cp, entry]) => [entry.values[0]!, entry.values[1]!, cp])
	.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
	.flat();
const propertyRows = [...rows("DerivedCoreProperties.txt"), ...rows("PropList.txt")];
for (const [name, property] of [
	["cased", "Cased"],
	["ignorable", "Case_Ignorable"],
	["softDotted", "Soft_Dotted"],
]) {
	const ranges = propertyRows
		.filter((row) => row[1] === property)
		.map((row) => {
			const pair = row[0]!.split("..");
			return [Number.parseInt(pair[0]!, 16), Number.parseInt(pair[1] ?? pair[0]!, 16)];
		})
		.sort((a, b) => a[0]! - b[0]!);
	data[name!] = ranges.flat();
}
data.pool = pool;
const provenance =
	"Generated by scripts/generate-unicode-data.ts from Unicode 18.0.0.\n// Unicode data license: runtime/vendor/unicode/LICENSE.txt.";
const ts = [`// ${provenance}`, 'export const UNICODE_VERSION = "18.0.0";'];
const c = [
	`// ${provenance}`,
	"#pragma once",
	'#include "defaults.h"',
	'#define MAL_UNICODE_VERSION "18.0.0"',
];
function cArray(
	name: string,
	type: "u8" | "u16" | "i32" | "u32",
	values: ReadonlyArray<number>,
): string {
	return `static const ${type} mal_unicode_${name}[] = {\n${Array.from({ length: Math.ceil(values.length / 16) }, (_, i) => `    ${values.slice(i * 16, i * 16 + 16).join(", ")},`).join("\n")}\n};`;
}
function pageOffsets(points: ReadonlyArray<number>): Array<number> {
	if (points.length > 0xffff) throw new Error("Normalization row index exceeds u16");
	const ends = new Array<number>(((points.at(-1) ?? 0) >> 8) + 2).fill(0);
	for (const point of points) ends[(point >> 8) + 1]!++;
	for (let page = 1; page < ends.length; page++) ends[page]! += ends[page - 1]!;
	return ends;
}

// Unicode mappings contain only scalars, leaving the surrogate range available
// as indices into the supplementary-scalar table.
const supplementary: Array<number> = [];
const supplementaryIds = new Map<number, number>();
function encodeScalar(point: number): number {
	if (point >= 0xd800 && point <= 0xdfff)
		throw new Error("Non-scalar normalization payload");
	if (point <= 0xffff) return point;
	let id = supplementaryIds.get(point);
	if (id === undefined) {
		id = supplementary.length;
		if (id >= 0x800)
			throw new Error("Supplementary normalization index exceeds surrogate range");
		supplementaryIds.set(point, id);
		supplementary.push(point);
	}
	return 0xd800 + id;
}

const normalizationPool: Array<number> = [];
const normalizationPoolOffsets = new Map<string, number>();
const decompositionPoints: Array<number> = [];
const decompositionRows: Array<number> = [];
for (const [point, { values, compatibility }] of [...decomposition].sort(
	([a], [b]) => a - b,
)) {
	const length = values.length;
	if (length === 0 || length > 31)
		throw new Error("Normalization mapping length exceeds five bits");
	let payload: number;
	if (length === 1) {
		payload = encodeScalar(values[0]!);
	} else {
		const key = values.join(",");
		let offset = normalizationPoolOffsets.get(key);
		if (offset === undefined) {
			offset = normalizationPool.length;
			if (offset > 0xffff) throw new Error("Normalization pool offset exceeds u16");
			normalizationPoolOffsets.set(key, offset);
			normalizationPool.push(...values.map(encodeScalar));
		}
		payload = offset;
	}
	decompositionPoints.push(point);
	const metadata = length | (compatibility ? 32 : 0);
	decompositionRows.push((((point & 255) << 24) | (metadata << 16) | payload) >>> 0);
}

const compositionPoints: Array<number> = [];
const compositionKeys: Array<number> = [];
const compositionValues: Array<number> = [];
for (let i = 0; i < data.composition.length; i += 3) {
	const first = data.composition[i]!;
	compositionPoints.push(first);
	compositionKeys.push(((first & 255) << 21) | data.composition[i + 1]!);
	compositionValues.push(encodeScalar(data.composition[i + 2]!));
}

c.push(
	"#if !defined(MAL_UNICODE_CASE_DATA)",
	`#define MAL_UNICODE_CLASS_BLOCK_BITS ${normalizationClassBits}`,
	cArray("class_blocks", "u8", normalizationClasses.indices),
	cArray("class_values", "u8", normalizationClasses.blocks),
	cArray("decomposition_pages", "u16", pageOffsets(decompositionPoints)),
	cArray("decomposition", "u32", decompositionRows),
	cArray("pool", "u16", normalizationPool),
	cArray("supplementary", "u32", supplementary),
	cArray("composition_pages", "u16", pageOffsets(compositionPoints)),
	cArray("composition_keys", "u32", compositionKeys),
	cArray("composition_values", "u16", compositionValues),
	"#endif",
	"#if defined(MAL_UNICODE_CASE_DATA)",
);
for (const name of ["cased", "ignorable", "softDotted"]) {
	c.push(
		cArray(
			name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
			"u32",
			data[name]!,
		),
	);
}
c.push("#endif");
// The shared byte index names a delta or a short expansion. Identity uses delta zero.
const caseBlockBits = 6;
const caseBlockSize = 1 << caseBlockBits;
const expansionBase = 0x110000;
const expansionPool: Array<number> = [];
const expansions = new Map<string, number>();
const caseClasses = deduplicateBlocks(caseClassValues, caseBlockSize / 4, "Case class");
c.push(
	"#if defined(MAL_UNICODE_CASE_DATA)",
	`#define MAL_UNICODE_CASE_BLOCK_BITS ${caseBlockBits}`,
	`#define MAL_UNICODE_CASE_EXPANSION_BASE ${expansionBase}`,
	cArray("case_class_blocks", "u8", caseClasses.indices),
	cArray("case_class_entries", "u8", caseClasses.blocks),
);
for (const name of ["lower", "upper"] as const) {
	const table = data[name]!;
	const entries = new Uint8Array(table.at(-3)! + 1);
	const mappings = [0];
	const mappingIds = new Map([[0, 0]]);
	for (let row = 0; row < table.length; row += 3) {
		const cp = table[row]!;
		const start = table[row + 1]!;
		const count = table[row + 2]!;
		let mapping: number;
		if (count === 1) {
			const target = pool[start]!;
			if (cp <= 0xffff !== target <= 0xffff)
				throw new Error("Simple case mapping changes UTF-16 width");
			mapping = target - cp;
		} else {
			if (count < 2 || count > 3) throw new Error("Unsupported case expansion length");
			const scalars = pool.slice(start, start + count);
			const key = scalars.join(",");
			let offset = expansions.get(key);
			if (offset === undefined) {
				offset = expansionPool.length;
				expansions.set(key, offset);
				expansionPool.push(...scalars);
			}
			mapping = expansionBase + offset * 4 + count;
		}
		let index = mappingIds.get(mapping);
		if (index === undefined) {
			index = mappings.length;
			if (index > 255) throw new Error(`${name} case mapping index exceeds u8`);
			mappingIds.set(mapping, index);
			mappings.push(mapping);
		}
		entries[cp] = index;
	}
	const encoded = deduplicateBlocks(entries, caseBlockSize, `${name} case`);
	c.push(
		cArray(`${name}_blocks`, "u8", encoded.indices),
		cArray(`${name}_entries`, "u8", encoded.blocks),
		cArray(`${name}_mappings`, "i32", mappings),
	);
}
c.push(cArray("case_expansions", "u32", expansionPool), "#endif");
ts.push(...unicodeTablesModule(data));
mkdirSync(output, { recursive: true });
const formatted = await format("unicode-data.ts", `${ts.join("\n")}\n`, {
	useTabs: true,
	printWidth: 90,
});
if (formatted.errors.length !== 0) throw new Error("Could not format Unicode data");
writeFileSync(resolve(output, "unicode-data.ts"), formatted.code);
writeFileSync(resolve(output, "unicode_data.h"), `${c.join("\n")}\n`);
console.log(
	JSON.stringify(
		{
			version: "18.0.0",
			sources,
			entries: Object.fromEntries(
				Object.entries(data).map(([key, values]) => [key, values.length]),
			),
			output,
		},
		null,
		2,
	),
);
