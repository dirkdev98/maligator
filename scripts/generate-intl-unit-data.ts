import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const revision = "7d2b9cb11cec08f4d333ad73209deb3df0711c3b";
const unitsDigest = "70649ffcf6876bce61aa5166a1c7cf5b5b5bc54f73e2e8f2b83aabe4c1875da7";
const grammarDigest = "083cb484b4545f06fa8b1c04f0b8b15190e4ee95e6bde748612ed6464ae345a2";
const parentsDigest = "e6d0da73b9e49dec3d9b94ed0bc16e7704b2efb769b7094c9c238cd654afb191";
const [directory, output, header] = process.argv.slice(2);
if (directory === undefined || output === undefined || header === undefined) {
	throw new Error(
		"Usage: node scripts/generate-intl-unit-data.ts <cldr-json-checkout> <output.rs> <unit-ids.h>",
	);
}

// ECMA-402 sanctioned simple identifiers: https://tc39.es/ecma402/#table-sanctioned-simple-unit-identifiers
const simple = [
	"acre",
	"bit",
	"byte",
	"celsius",
	"centimeter",
	"day",
	"degree",
	"fahrenheit",
	"fluid-ounce",
	"foot",
	"gallon",
	"gigabit",
	"gigabyte",
	"gram",
	"hectare",
	"hour",
	"inch",
	"kilobit",
	"kilobyte",
	"kilogram",
	"kilometer",
	"liter",
	"megabit",
	"megabyte",
	"meter",
	"microsecond",
	"mile",
	"mile-scandinavian",
	"milliliter",
	"millimeter",
	"millisecond",
	"minute",
	"month",
	"nanosecond",
	"ounce",
	"percent",
	"petabyte",
	"pound",
	"second",
	"stone",
	"terabit",
	"terabyte",
	"week",
	"yard",
	"year",
];
const sourceDirectory = directory;
const widths = ["long", "short", "narrow"] as const;
const plurals = ["zero", "one", "two", "few", "many", "other"] as const;
type Unit = Record<string, string>;
type Units = Record<(typeof widths)[number], Record<string, Unit>>;
type Source = { main: Record<string, { units: Units }> };
type Derivation = { _value0: string; _value1: string };

function checkedJson<T>(name: string, digest: string): T {
	const bytes = readFileSync(join(sourceDirectory, name));
	if (createHash("sha256").update(bytes).digest("hex") !== digest) {
		throw new Error(`CLDR source checksum mismatch: ${name}`);
	}
	return JSON.parse(bytes.toString("utf8")) as T;
}
const parents = checkedJson<{
	supplemental: { parentLocales: { parentLocale: Record<string, string> } };
}>("cldr-json/cldr-core/supplemental/parentLocales.json", parentsDigest).supplemental
	.parentLocales.parentLocale;
const grammar = checkedJson<{
	supplemental: { grammaticalData: Record<string, Record<string, unknown>> };
}>("cldr-json/cldr-core/supplemental/grammaticalFeatures.json", grammarDigest)
	.supplemental.grammaticalData;
const unitDirectory = join(sourceDirectory, "cldr-json/cldr-units-full/main");
const files = readdirSync(unitDirectory, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => `${entry.name}.json`)
	.sort();
const aggregate = createHash("sha256");
const sources = files.map((name) => {
	if (!/^[A-Za-z0-9-]+\.json$/.test(name))
		throw new Error(`Invalid CLDR source name: ${name}`);
	const bytes = readFileSync(join(unitDirectory, name.slice(0, -5), "units.json"));
	aggregate.update(`${name}\0${bytes.length}\0`).update(bytes);
	return { locale: name.slice(0, -5), bytes };
});
if (aggregate.digest("hex") !== unitsDigest)
	throw new Error("CLDR unit source checksum mismatch");
sources.sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0));
if (
	sources.some(
		({ locale }, index) => index > 0 && sources[index - 1]!.locale >= locale,
	) ||
	simple.some((name, index) => index > 0 && simple[index - 1]! >= name)
) {
	throw new Error("CLDR binary-search keys must be strictly ordered");
}
const english = sources.find(({ locale }) => locale === "en");
if (english === undefined) throw new Error("Missing English CLDR unit fallback");
const reference = (JSON.parse(english.bytes.toString("utf8")) as Source).main.en!.units
	.long;
const byName = new Map(
	Object.keys(reference).map((key) => [key.slice(key.indexOf("-") + 1), key]),
);
const keys = simple.map((name) => {
	const key = byName.get(name);
	if (key === undefined) throw new Error(`Missing sanctioned unit: ${name}`);
	return key;
});
const compounds = [...byName.keys()]
	.map((name) => name.split("-per-"))
	.filter((pair) => pair.length === 2 && pair.every((name) => simple.includes(name)))
	.map(
		([numerator, denominator]) =>
			[simple.indexOf(numerator!), simple.indexOf(denominator!)] as const,
	)
	.sort(([a, b], [c, d]) => a - c || b - d);
for (const [a, b] of compounds) keys.push(byName.get(`${simple[a]}-per-${simple[b]}`)!);

function parent(locale: string): string | undefined {
	return (
		parents[locale] ??
		(locale.includes("-") ? locale.slice(0, locale.lastIndexOf("-")) : undefined)
	);
}
function component(locale: string, feature: "case" | "plural"): string {
	const visited = new Set<string>();
	for (
		let current: string | undefined = locale;
		current !== undefined;
		current = parent(current)
	) {
		if (visited.has(current)) throw new Error(`CLDR parent cycle: ${locale}`);
		visited.add(current);
		const value = grammar[current]?.[
			`deriveComponent-feature-${feature}-structure-per`
		] as Derivation | undefined;
		if (value !== undefined) {
			if (value._value0 !== "compound")
				throw new Error(`Unsupported numerator derivation: ${current}`);
			return value._value1;
		}
	}
	const fallback = grammar.und?.[`deriveComponent-feature-${feature}-structure-per`] as
		| Derivation
		| undefined;
	if (fallback === undefined || fallback._value0 !== "compound")
		throw new Error("Missing CLDR per derivation");
	return fallback._value1;
}
function pattern(
	text: string,
	argumentsAllowed: ReadonlyArray<string>,
	required: ReadonlyArray<string> = [],
): string {
	if (text.includes("↑↑↑") || text.includes("∅∅∅") || text.includes("\0"))
		throw new Error("Unresolved CLDR unit inheritance");
	const argumentsFound = [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!);
	if (
		text.replace(/\{[^{}]*\}/g, "").includes("{") ||
		text.replace(/\{[^{}]*\}/g, "").includes("}") ||
		argumentsFound.some((value) => !argumentsAllowed.includes(value)) ||
		new Set(argumentsFound).size !== argumentsFound.length ||
		required.some((value) => !argumentsFound.includes(value))
	) {
		throw new Error(`Unsupported CLDR unit pattern: ${text}`);
	}
	return text;
}
const texts = [""];
const textIds = new Map([["", 0]]);
function internText(text: string): number {
	let id = textIds.get(text);
	if (id === undefined) {
		id = texts.length;
		texts.push(text);
		textIds.set(text, id);
	}
	if (id > 0xffff) throw new Error("CLDR pattern index exceeds u16");
	return id;
}
const records: Array<Array<number>> = [];
const recordIds = new Map<string, number>();
const tables: Array<Array<number>> = [];
const tableIds = new Map<string, number>();
function internRow(
	row: Array<number>,
	rows: Array<Array<number>>,
	ids: Map<string, number>,
): number {
	const key = row.join(",");
	let id = ids.get(key);
	if (id === undefined) {
		id = rows.length;
		rows.push(row);
		ids.set(key, id);
	}
	if (id > 0xffff) throw new Error("CLDR row index exceeds u16");
	return id;
}
const locales: Array<[string, Array<number>]> = [];
for (const { locale, bytes } of sources) {
	const units = (JSON.parse(bytes.toString("utf8")) as Source).main[locale]?.units;
	if (units === undefined) throw new Error(`Missing CLDR locale: ${locale}`);
	const denominatorCase = component(locale, "case");
	const denominatorPlural = component(locale, "plural");
	const localeTables = widths.map((width) => {
		const data = units[width];
		const row = keys.map((key) => {
			const unit = data[key];
			if (unit === undefined || !unit["unitPattern-count-other"])
				throw new Error(`Incomplete CLDR unit: ${locale}/${width}/${key}`);
			const forms = plurals.map((plural) =>
				internText(pattern(unit[`unitPattern-count-${plural}`] ?? "", ["0"])),
			);
			const per = unit.perUnitPattern;
			forms.push(internText(per === undefined ? "" : pattern(per, ["0"], ["0"])));
			const denominator =
				unit[`unitPattern-count-${denominatorPlural}-case-${denominatorCase}`] ??
				unit[`unitPattern-count-${denominatorPlural}`] ??
				unit["unitPattern-count-other"];
			forms.push(internText(pattern(denominator, ["0"]).replace("{0}", "").trim()));
			return internRow(forms, records, recordIds);
		});
		row.push(
			internText(pattern(data.per?.compoundUnitPattern ?? "", ["0", "1"], ["0", "1"])),
		);
		return internRow(row, tables, tableIds);
	});
	locales.push([locale, localeTables]);
}
function rust(text: string): string {
	const escaped = Array.from(text, (character) => {
		if (character === "\\") return "\\\\";
		if (character === '"') return '\\"';
		const code = character.codePointAt(0)!;
		return code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : character;
	}).join("");
	return `"${escaped}"`;
}

let textBytes = 0;
const offsets = texts.map((text) => {
	const offset = textBytes;
	textBytes += Buffer.byteLength(text);
	return offset;
});
offsets.push(textBytes);
if (textBytes > 0xffffffff) throw new Error("CLDR text exceeds u32 offsets");
const lines = [
	"// Generated by scripts/generate-intl-unit-data.ts; do not edit.",
	`// CLDR ${revision}; unit sources SHA256 ${unitsDigest}.`,
	`// Grammar SHA256 ${grammarDigest}; parents SHA256 ${parentsDigest}.`,
	"// Unicode-3.0; see runtime/vendor/cldr/LICENSE and THIRD_PARTY_NOTICES.md.",
	"#[rustfmt::skip]",
	`pub(super) static SIMPLE: &[&str] = &[${simple.map(rust).join(",")}];`,
	"#[rustfmt::skip]",
	`pub(super) static COMPOUNDS: &[(u8,u8)] = &[${compounds.map(([a, b]) => `(${a},${b})`).join(",")}];`,
	"#[rustfmt::skip]",
	"pub(super) static TEXT: &str = concat!(",
	...texts.map((text) => `    ${rust(text)},`),
	");",
	"#[rustfmt::skip]",
	`pub(super) static OFFSETS: &[u32] = &[${offsets.join(",")}];`,
	"#[rustfmt::skip]",
	"pub(super) static FORMS: &[[u16;8]] = &[",
	...records.map((row) => `    [${row.join(",")}],`),
	"];",
	"#[rustfmt::skip]",
	`pub(super) static TABLES: &[[u16;${keys.length + 1}]] = &[`,
	...tables.map((row) => `    [${row.join(",")}],`),
	"];",
	"#[rustfmt::skip]",
	"pub(super) static LOCALES: &[(&str,[u16;3])] = &[",
	...locales.map(([locale, row]) => `    (${rust(locale)},[${row.join(",")}]),`),
	"];",
	"#[rustfmt::skip]",
	"pub(super) static PARENTS: &[(&str,&str)] = &[",
	...Object.entries(parents)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([child, value]) => `    (${rust(child)},${rust(value)}),`),
	"];",
	"",
];
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, lines.join("\n"));
mkdirSync(dirname(resolve(header)), { recursive: true });
writeFileSync(
	header,
	[
		"// Generated by scripts/generate-intl-unit-data.ts; do not edit.",
		"#ifndef MAL_INTL_UNIT_IDS_H",
		"#define MAL_INTL_UNIT_IDS_H",
		"static const char *const SUPPORTED_UNITS[] = {",
		...simple.map((unit) => `    ${JSON.stringify(unit)},`),
		"};",
		"#endif",
		"",
	].join("\n"),
);
console.log(
	JSON.stringify({
		output: resolve(output),
		locales: locales.length,
		patterns: texts.length,
		records: records.length,
		tables: tables.length,
		textBytes,
		tableBytes:
			offsets.length * 4 +
			records.length * 16 +
			tables.reduce((sum, row) => sum + row.length * 2, 0),
		sourceBytes: Buffer.byteLength(lines.join("\n")),
	}),
);
