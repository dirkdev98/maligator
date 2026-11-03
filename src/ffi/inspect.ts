import * as path from "node:path";
import type { BindingPlan, BoundFunction, Gap, JsValue } from "./binding-plan.ts";
import type {
	CEnum,
	CFunction,
	CMacro,
	CModel,
	CRecord,
	CTarget,
	CTypedef,
} from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { LibraryContract, LibraryFacts } from "./contract.ts";
import type { LinkInput, ResolvedLibrary } from "./discovery.ts";
import { suggestFacts } from "./suggest.ts";
import type { SuggestedFacts } from "./suggest.ts";
import type { FfiText } from "./text.ts";

/**
 * Everything the build knows about a library, in a stable JSON shape: where it was
 * found, each declaration with its C and TypeScript forms, and the facts missing
 * for the declarations that cannot bind yet. Tools that propose facts read this.
 */
export interface FfiInspectionData {
	readonly library: string;
	readonly contract: string;
	readonly resolution: {
		readonly method: ResolvedLibrary["method"];
		readonly package?: string;
		readonly version?: string;
		readonly link: "static" | "shared";
		readonly compileArguments: ReadonlyArray<string>;
		readonly linkInputs: ReadonlyArray<LinkInput>;
		readonly sources: ReadonlyArray<string>;
	};
	readonly compiler: { readonly path: string; readonly version: string };
	readonly target: CTarget;
	readonly headers: ReadonlyArray<{ readonly spelling: string; readonly path: string }>;
	readonly files: ReadonlyArray<string>;
	/** Structured declarations, including unmapped and transitive system types. */
	readonly model: CModelInspectionData;
	/** Accepted contract facts, before naming and signature suggestions. */
	readonly facts: LibraryFacts;
	readonly summary: {
		readonly functions: number;
		readonly bound: number;
		readonly needFacts: number;
		readonly types: number;
		readonly constants: number;
		readonly skippedConstants: number;
	};
	readonly functions: ReadonlyArray<FunctionInspectionData>;
	readonly types: ReadonlyArray<TypeInspectionData>;
	readonly handles: ReadonlyArray<HandleInspectionData>;
	readonly natives: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		readonly sizeBits: number;
		readonly alignmentBits: number;
	}>;
	readonly constants: ReadonlyArray<ConstantInspectionData>;
	readonly skippedConstants: ReadonlyArray<{
		readonly name: string;
		readonly reason: string;
	}>;
	/** Facts that would bind more functions, in contract shape, to review and merge. */
	readonly suggestions: SuggestedFacts;
}

/** JSON keeps declaration maps as arrays and exact C integer values as decimal strings. */
export interface CModelInspectionData extends Omit<
	CModel,
	"records" | "enums" | "typedefs" | "macros"
> {
	readonly records: ReadonlyArray<CRecord>;
	readonly typedefs: ReadonlyArray<CTypedef>;
	readonly enums: ReadonlyArray<
		Omit<CEnum, "constants"> & {
			readonly constants: ReadonlyArray<
				Omit<CEnum["constants"][number], "value"> & { readonly value: string }
			>;
		}
	>;
	readonly macros: ReadonlyArray<
		Omit<CMacro, "value"> & { readonly value?: number | string }
	>;
}

function inspectModel(model: CModel): CModelInspectionData {
	const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	return {
		...model,
		records: [...model.records.values()].sort(byName),
		typedefs: [...model.typedefs.values()].sort(byName),
		enums: [...model.enums.values()].sort(byName).map((entry) => ({
			...entry,
			constants: entry.constants.map((constant) => ({
				...constant,
				value: constant.value.toString(),
			})),
		})),
		macros: model.macros.map(({ value, ...macro }) => ({
			...macro,
			...(value === undefined
				? {}
				: { value: typeof value === "bigint" ? value.toString() : value }),
		})),
	};
}

export interface FunctionInspectionData {
	readonly name: string;
	readonly global?: { readonly name: string; readonly access: "get" | "set" };
	/** The variadic C function a variant calls; its arguments follow the fixed ones. */
	readonly variantOf?: string;
	readonly dispatchOf?: string;
	readonly variants?: ReadonlyArray<string>;
	readonly status: "bound" | "needs-facts";
	readonly c: string;
	readonly ts?: string;
	readonly doc?: FfiText;
	readonly location: { readonly file: string; readonly line: number };
	readonly inline?: true;
	readonly attributes?: ReadonlyArray<string>;
	readonly params: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		/** How the binding produces the argument: input, out, inout, a count, or result-count. */
		readonly role?: string;
		readonly ts?: string;
		readonly doc?: FfiText;
	}>;
	readonly returns: { readonly c: string; readonly ts?: string };
	readonly gaps?: ReadonlyArray<Gap>;
}

export interface TypeInspectionData {
	readonly name: string;
	readonly c: string;
	readonly ts: string;
	readonly doc?: FfiText;
	readonly cases?: ReadonlyArray<{
		readonly tag: string;
		readonly selection: ReadonlyArray<string>;
		readonly ts: string;
	}>;
	readonly fields: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		readonly ts: string;
		readonly doc?: FfiText;
	}>;
}

export interface HandleInspectionData {
	readonly name: string;
	readonly c: string;
	/** A copy of a struct the library passes by value, or a pointer it returns. */
	readonly representation: "struct" | "pointer";
	readonly allocator?: string;
	readonly trailing?: string;
	readonly layout?: { readonly size: string; readonly alignment: string };
	readonly views?: ReadonlyArray<string>;
	readonly destroy?: string;
	readonly destroySuccess?: string;
	readonly collect: boolean;
	readonly doc?: FfiText;
	/** Value accessors on a struct handle or caller factory result. */
	readonly fields: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		readonly ts: string;
		readonly set?: string;
	}>;
}

export interface ConstantInspectionData {
	readonly name: string;
	readonly source: "enum" | "macro";
	readonly c: string;
	readonly ts: string;
	/** Bigint values are decimal strings; absent when the binding evaluates the C expression. */
	readonly value?: number | string;
	readonly doc?: FfiText;
}

const RESERVED = new Set(
	(
		"break case catch class const continue debugger default delete do else enum export extends " +
		"false finally for function if import in instanceof new null return super switch this throw " +
		"true try typeof var void while with yield let static implements interface package private " +
		"protected public await arguments eval"
	).split(" "),
);

/** The kind of fact a gap reason asks for. */
function gapNeed(reason: string): string {
	if (reason.includes("handle fact")) return "a handle type";
	if (reason.includes("callback")) return "a callback";
	if (reason.includes("variadic")) return "variants";
	if (reason.includes("pointer")) return "a pointer fact";
	if (reason.includes("char")) return "text or bytes";
	return "other facts";
}

function contractKey(key: string): string {
	return /^(?:[A-Za-z_$][\w$]*|[1-9]\d*)$/.test(key) ? key : JSON.stringify(key);
}

/** A fact value as a contract spells it: plain keys and one line. */
function contractValue(value: unknown): string {
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	const entries = Object.entries(value);
	return entries.length === 0
		? "{}"
		: `{ ${entries.map(([key, inner]) => `${contractKey(key)}: ${contractValue(inner)}`).join(", ")} }`;
}

/** A C parameter name usable as a TypeScript parameter name. */
export function tsParameterName(name: string): string {
	return RESERVED.has(name) ? `${name}_` : name;
}

/** The TypeScript type of a mapped value; arrays of up to 16 elements become tuples. */
export function formatTsType(
	value: JsValue,
	direction: "input" | "output" = "output",
): string {
	const nullable = (type: string): string =>
		"nullable" in value && value.nullable ? `${type} | null` : type;
	switch (value.kind) {
		case "callable": {
			const type = `(${formatTsParameters(value.signature)}) => ${formatTsResult(value.signature)}`;
			return `(${type}) | null`;
		}
		case "bytes":
			return nullable(
				direction === "input" ? "ArrayBufferLike | ArrayBufferView" : "Uint8Array",
			);
		case "callback": {
			const params = value.params
				.filter((param): param is JsValue => param !== "data" && param !== "count")
				.map((param, index) => `arg${index + 1}: ${formatTsType(param)}`);
			const type = `(${params.join(", ")}) => ${formatTsType(value.returns, "input")}`;
			return value.nullable ? `(${type}) | null` : type;
		}
		case "sequence": {
			const element = formatTsType(value.of, direction);
			return nullable(
				direction === "input" ? `ReadonlyArray<${element}>` : `Array<${element}>`,
			);
		}
		case "undefined":
			return "void";
		case "boolean":
			return "boolean";
		case "integer":
		case "float":
			return "number";
		case "bigint":
			return "bigint";
		case "string":
			return nullable("string");
		case "record":
			return value.name;
		case "tagged":
			return (
				value.alias ??
				`(${value.cases.map((entry) => `({ ${value.tag}: ${entry.literal} } & ${formatTsType(entry.value, direction)})`).join(" | ")})`
			);
		case "union":
			return value.alias ?? formatTsType(value.of, direction);
		case "handle":
			return nullable(value.name);
		case "native":
			return value.name;
		case "array": {
			if (value.format === "string") return "string";
			if (value.format === "bytes")
				return direction === "input" ? "ArrayBufferLike | ArrayBufferView" : "Uint8Array";
			const element = formatTsType(value.of, direction);
			return value.length <= 16
				? `[${Array.from({ length: value.length }, () => element).join(", ")}]`
				: `Array<${element}>`;
		}
	}
}

/** What a bound function returns: its result, or an object with its outputs. */
export function formatTsResult(binding: BoundFunction): string {
	if (binding.outputs.length === 0) return formatTsType(binding.returns);
	const fields = [
		...(binding.returns.kind === "undefined"
			? []
			: [`result: ${formatTsType(binding.returns)}`]),
		...binding.outputs.map((output) => `${output.name}: ${formatTsType(output.value)}`),
	];
	return `{ ${fields.join("; ")} }`;
}

/** A bound function's TypeScript parameter list. */
export function formatTsParameters(binding: BoundFunction): string {
	return binding.params
		.map(
			(param) => `${tsParameterName(param.name)}: ${formatTsType(param.value, "input")}`,
		)
		.join(", ");
}

/** Correlate a runtime selector with the visible arguments of its typed C wrapper. */
export function formatTsDispatchArgs(binding: BoundFunction): string {
	const parameters = formatTsParameters(binding);
	return `[variant: ${JSON.stringify(binding.name)}${parameters === "" ? "" : `, ${parameters}`}]`;
}

/** A C prototype with parameter names, as a header would declare it. */
export function formatCFunction(declaration: CFunction): string {
	const params = [
		...declaration.params.map((param) =>
			formatCDeclaration(param.type, param.name ?? ""),
		),
		...(declaration.variadic ? ["..."] : []),
	];
	return `${formatCDeclaration(
		declaration.returns,
		`${declaration.name}(${params.length === 0 ? "void" : params.join(", ")})`,
	)};`;
}

export function inspectBindings(
	contract: LibraryContract,
	projectRoot: string,
	library: ResolvedLibrary,
	compiler: { path: string; version: string },
	model: CModel,
	plan: BindingPlan,
): FfiInspectionData {
	const bound = new Map(plan.functions.map((entry) => [entry.name, entry]));
	const unbound = new Map(plan.unbound.map((entry) => [entry.name, entry]));
	// A variadic function with variants is reported as its variants.
	const variants = new Map<string, Array<{ name: string; declaration: CFunction }>>();
	for (const entry of [...plan.functions, ...plan.unbound]) {
		if ("dispatchOf" in entry) continue;
		if (entry.global !== undefined || entry.name === entry.declaration.name) continue;
		const list = variants.get(entry.declaration.name) ?? [];
		list.push({ name: entry.name, declaration: entry.declaration });
		variants.set(entry.declaration.name, list);
	}
	const entries = [
		...model.functions.flatMap(
			(declaration) =>
				variants.get(declaration.name) ?? [{ name: declaration.name, declaration }],
		),
		...[...plan.functions, ...plan.unbound].filter((entry) => entry.global !== undefined),
		...plan.unbound.filter((entry) => entry.dispatchOf !== undefined),
	];
	const functions = entries.map(({ name, declaration }): FunctionInspectionData => {
		const binding = bound.get(name);
		const global = binding?.global ?? unbound.get(name)?.global;
		const gaps = unbound.get(name)?.gaps;
		const dispatchOf = unbound.get(name)?.dispatchOf;
		const params = declaration.params.map((param, index) => {
			const argument = binding?.arguments[index];
			const role =
				argument === undefined
					? undefined
					: argument.kind === "count"
						? `count of ${argument.of.map((source) => binding!.declaration.params[source]?.name ?? `arg${source + 1}`).join(", ")}`
						: argument.kind;
			const ts =
				argument?.kind === "input" || argument?.kind === "inout"
					? formatTsType(binding!.params[argument.param]!.value, "input")
					: argument?.kind === "out"
						? formatTsType(binding!.outputs[argument.output]!.value)
						: undefined;
			return {
				name: param.name ?? `arg${index + 1}`,
				c: formatCDeclaration(param.type),
				...(role === undefined ? {} : { role }),
				...(ts === undefined ? {} : { ts }),
				...(param.doc === undefined ? {} : { doc: param.doc }),
			};
		});
		const returns = {
			c: formatCDeclaration(declaration.returns),
			...(binding === undefined ? {} : { ts: formatTsType(binding.returns) }),
		};
		const signature =
			binding === undefined
				? undefined
				: `(${formatTsParameters(binding)}) => ${formatTsResult(binding)}`;
		return {
			name,
			...(dispatchOf === undefined ? {} : { dispatchOf }),
			...(global !== undefined
				? { global: { name: global.declaration.name, access: global.access } }
				: name === declaration.name
					? {}
					: { variantOf: declaration.name }),
			status: binding === undefined ? "needs-facts" : "bound",
			c:
				global === undefined
					? formatCFunction(declaration)
					: `extern ${global.declaration.threadLocal ? "_Thread_local " : ""}${formatCDeclaration(global.declaration.type, global.declaration.name)};`,
			...(signature === undefined ? {} : { ts: signature }),
			...(declaration.doc === undefined ? {} : { doc: declaration.doc }),
			location: declaration.location,
			...(global === undefined && declaration.inline ? { inline: true as const } : {}),
			...(declaration.attributes.length === 0
				? {}
				: { attributes: declaration.attributes }),
			params,
			returns,
			...(gaps === undefined ? {} : { gaps }),
		};
	});
	for (const dispatch of plan.dispatchers)
		functions.push({
			name: dispatch.name,
			dispatchOf: dispatch.declaration.name,
			variants: dispatch.cases.map((binding) => binding.name),
			status: "bound",
			c: formatCFunction(dispatch.declaration),
			ts: `(...args: ${dispatch.cases.map(formatTsDispatchArgs).join(" | ")}) => ${[...new Set(dispatch.cases.map(formatTsResult))].join(" | ")}`,
			location: dispatch.declaration.location,
			params: [],
			returns: { c: formatCDeclaration(dispatch.declaration.returns) },
		});
	const types = [...plan.records.values()]
		.filter((entry) => entry.record.library)
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map((entry): TypeInspectionData => ({
			name: entry.name,
			c: entry.spelling,
			ts: `{ ${entry.fields.map((field) => `${field.name}: ${formatTsType(field.value)}`).join("; ")} }`,
			...(entry.record.doc === undefined ? {} : { doc: entry.record.doc }),
			fields: entry.fields.map((field) => ({
				name: field.name,
				c: `${formatCDeclaration(field.type)}${field.bitWidth === undefined ? "" : ` : ${field.bitWidth}`}`,
				ts: formatTsType(field.value),
				...(field.doc === undefined ? {} : { doc: field.doc }),
			})),
		}));
	for (const union of plan.unions.values())
		types.push({
			name: union.alias ?? union.name,
			c: union.spelling,
			ts: formatTsType(union.member.value),
			fields: [
				{
					name: union.member.name,
					c: formatCDeclaration(union.member.type),
					ts: formatTsType(union.member.value),
				},
			],
		});
	for (const tagged of plan.tagged.values())
		types.push({
			name: tagged.alias ?? tagged.name,
			c: tagged.spelling,
			ts: formatTsType({
				kind: "tagged",
				name: tagged.name,
				tag: tagged.tag.name,
				cases: tagged.cases.map((entry) => ({
					literal: entry.literal,
					value: { kind: "record", name: entry.record.name },
				})),
			}),
			fields: [
				{
					name: tagged.tag.name,
					c: formatCDeclaration(tagged.tag.type),
					ts: formatTsType(tagged.tag.value),
				},
			],
			cases: tagged.cases.map((entry) => ({
				tag: entry.literal,
				selection: entry.selection,
				ts: formatTsType({ kind: "record", name: entry.record.name }),
			})),
		});
	const constants = plan.constants.map((constant): ConstantInspectionData => ({
		name: constant.name,
		source: constant.source,
		c: formatCDeclaration(constant.type),
		ts: formatTsType(constant.value),
		...(constant.known === undefined
			? {}
			: {
					value:
						typeof constant.known === "bigint"
							? constant.known.toString()
							: constant.known,
				}),
		...(constant.doc === undefined ? {} : { doc: constant.doc }),
	}));
	return {
		library: contract.name,
		contract: path.relative(projectRoot, contract.path),
		resolution: {
			method: library.method,
			...(library.package === undefined ? {} : { package: library.package }),
			...(library.version === undefined ? {} : { version: library.version }),
			link: library.link,
			compileArguments: library.compileArguments,
			linkInputs: library.linkInputs,
			sources: library.sources,
		},
		compiler,
		target: model.target,
		headers: model.headers,
		files: model.files,
		model: inspectModel(model),
		facts: contract.facts,
		summary: {
			functions: functions.length,
			bound: plan.functions.length + plan.dispatchers.length,
			needFacts: plan.unbound.length,
			types: types.length + plan.natives.size,
			constants: constants.length,
			skippedConstants: plan.skippedConstants.length,
		},
		functions,
		types,
		natives: [...plan.natives.values()].map(({ name, sizeBits, alignmentBits }) => ({
			name,
			c: name,
			sizeBits,
			alignmentBits,
		})),
		handles: [...plan.handles.values()].map((handle) => ({
			name: handle.name,
			c: handle.spelling,
			representation: handle.representation,
			...(handle.views.length === 0 ? {} : { views: handle.views }),
			...(handle.allocator === undefined ? {} : { allocator: handle.allocator }),
			...(handle.trailing === undefined ? {} : { trailing: handle.trailing }),
			...(handle.layout === undefined ? {} : { layout: handle.layout }),
			...(handle.destroy === undefined ? {} : { destroy: handle.destroy.name }),
			...(handle.destroy?.success === undefined
				? {}
				: { destroySuccess: handle.destroy.success }),
			collect: handle.collect,
			...(handle.doc === undefined ? {} : { doc: handle.doc }),
			fields: [
				...handle.fields.map((field) => ({
					name: field.name,
					c: `${formatCDeclaration(field.type)}${field.bitWidth === undefined ? "" : ` : ${field.bitWidth}`}`,
					ts: formatTsType(field.value),
				})),
				...handle.managedFields.map((field) => ({
					name: field.name,
					c: formatCDeclaration(field.type),
					ts: field.kind === "string" ? "string | null" : "Uint8Array | null",
					set:
						field.kind === "string"
							? "string | null"
							: "ArrayBuffer | ArrayBufferView | null",
				})),
			],
		})),
		constants,
		skippedConstants: plan.skippedConstants,
		suggestions: suggestFacts(model, contract.facts, plan),
	};
}

/** A short human summary; `--json` carries the full detail. */
export function formatInspection(inspection: FfiInspectionData): string {
	const { resolution, summary } = inspection;
	const source =
		resolution.method === "pkg-config"
			? `pkg-config ${resolution.package}`
			: resolution.method === "paths"
				? "configured paths"
				: "sources";
	const lines = [
		`${inspection.library}${resolution.version === undefined ? "" : ` ${resolution.version}`}: ${source}, ${resolution.link} link`,
		...inspection.headers.map((header) => `  ${header.path}`),
		`  ${summary.bound} of ${summary.functions} functions bound, ${summary.types} value types, ${summary.constants} constants`,
	];
	const needFacts = inspection.functions.filter(
		(entry) => entry.status === "needs-facts",
	);
	if (needFacts.length > 0) {
		// What the gaps ask for, so a large library shows which facts unlock the most.
		const needs = new Map<string, number>();
		for (const entry of needFacts) {
			for (const need of new Set((entry.gaps ?? []).map((gap) => gapNeed(gap.reason))))
				needs.set(need, (needs.get(need) ?? 0) + 1);
		}
		lines.push(
			"",
			`Functions that need facts, by what they need: ${[...needs]
				.sort(([, left], [, right]) => right - left)
				.map(([need, count]) => `${count} ${need}`)
				.join(", ")}`,
		);
		for (const entry of needFacts) {
			for (const gap of entry.gaps ?? [])
				lines.push(`  ${entry.name} ${gap.at}: ${gap.reason}`);
		}
	}
	const { suggestions } = inspection;
	if (suggestions.binds.length > 0) {
		lines.push(
			"",
			`Suggested facts that bind ${suggestions.binds.length} more functions; review them before adding them to the contract:`,
		);
		// Contract syntax, so the blocks paste into `defineLibrary`.
		for (const [key, entries] of [
			["types", suggestions.types],
			["functions", suggestions.functions],
		] as const) {
			if (Object.keys(entries).length === 0) continue;
			lines.push(`  ${key}: {`);
			for (const [name, facts] of Object.entries(entries))
				lines.push(`    ${contractKey(name)}: ${contractValue(facts)},`);
			lines.push("  },");
		}
	}
	if (inspection.skippedConstants.length > 0) {
		lines.push("", "Macros and constants without a mapping:");
		for (const entry of inspection.skippedConstants)
			lines.push(`  ${entry.name}: ${entry.reason}`);
	}
	return lines.join("\n");
}

/** The CLI wire representation keeps prose as ordinary JSON strings. */
type JsonText<Value> = Value extends FfiText
	? string
	: Value extends ReadonlyArray<infer Element>
		? ReadonlyArray<JsonText<Element>>
		: Value extends object
			? { [Key in keyof Value]: JsonText<Value[Key]> }
			: Value;
export type FfiInspection = JsonText<FfiInspectionData>;
export type CModelInspection = JsonText<CModelInspectionData>;
export type FunctionInspection = JsonText<FunctionInspectionData>;
export type TypeInspection = JsonText<TypeInspectionData>;
export type HandleInspection = JsonText<HandleInspectionData>;
export type ConstantInspection = JsonText<ConstantInspectionData>;
