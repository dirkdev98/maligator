import * as path from "node:path";
import type { BindingPlan, Gap, JsValue } from "./binding-plan.ts";
import type { CFunction, CModel, CTarget } from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { LibraryContract } from "./contract.ts";
import type { LinkInput, ResolvedLibrary } from "./discovery.ts";

/**
 * Everything the build knows about a library, in a stable JSON shape: where it was
 * found, each declaration with its C and TypeScript forms, and the facts missing
 * for the declarations that cannot bind yet. Tools that propose facts read this.
 */
export interface FfiInspection {
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
	readonly summary: {
		readonly functions: number;
		readonly bound: number;
		readonly needFacts: number;
		readonly types: number;
		readonly constants: number;
		readonly skippedConstants: number;
	};
	readonly functions: ReadonlyArray<FunctionInspection>;
	readonly types: ReadonlyArray<TypeInspection>;
	readonly constants: ReadonlyArray<ConstantInspection>;
	readonly skippedConstants: ReadonlyArray<{
		readonly name: string;
		readonly reason: string;
	}>;
}

export interface FunctionInspection {
	readonly name: string;
	readonly status: "bound" | "needs-facts";
	readonly c: string;
	readonly ts?: string;
	readonly doc?: string;
	readonly location: { readonly file: string; readonly line: number };
	readonly inline?: true;
	readonly attributes?: ReadonlyArray<string>;
	readonly params: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		readonly ts?: string;
		readonly doc?: string;
	}>;
	readonly returns: { readonly c: string; readonly ts?: string };
	readonly gaps?: ReadonlyArray<Gap>;
}

export interface TypeInspection {
	readonly name: string;
	readonly c: string;
	readonly ts: string;
	readonly doc?: string;
	readonly fields: ReadonlyArray<{
		readonly name: string;
		readonly c: string;
		readonly ts: string;
		readonly doc?: string;
	}>;
}

export interface ConstantInspection {
	readonly name: string;
	readonly source: "enum" | "macro";
	readonly c: string;
	readonly ts: string;
	/** Bigint values are decimal strings; absent when the binding evaluates the C expression. */
	readonly value?: number | string;
	readonly doc?: string;
}

const RESERVED = new Set(
	(
		"break case catch class const continue debugger default delete do else enum export extends " +
		"false finally for function if import in instanceof new null return super switch this throw " +
		"true try typeof var void while with yield let static implements interface package private " +
		"protected public await arguments eval"
	).split(" "),
);

/** A C parameter name usable as a TypeScript parameter name. */
export function tsParameterName(name: string): string {
	return RESERVED.has(name) ? `${name}_` : name;
}

/** The TypeScript type of a mapped value; arrays of up to 16 elements become tuples. */
export function formatTsType(value: JsValue): string {
	switch (value.kind) {
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
			return value.nullable ? "string | null" : "string";
		case "record":
			return value.name;
		case "array": {
			const element = formatTsType(value.of);
			return value.length <= 16
				? `[${Array.from({ length: value.length }, () => element).join(", ")}]`
				: `Array<${element}>`;
		}
	}
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
): FfiInspection {
	const bound = new Map(plan.functions.map((entry) => [entry.name, entry]));
	const unbound = new Map(plan.unbound.map((entry) => [entry.name, entry]));
	const functions = model.functions.map((declaration): FunctionInspection => {
		const binding = bound.get(declaration.name);
		const gaps = unbound.get(declaration.name)?.gaps;
		const params = declaration.params.map((param, index) => {
			const mapped = binding?.params[index];
			return {
				name: param.name ?? `arg${index + 1}`,
				c: formatCDeclaration(param.type),
				...(mapped === undefined ? {} : { ts: formatTsType(mapped.value) }),
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
				: `(${binding.params
						.map(
							(param) => `${tsParameterName(param.name)}: ${formatTsType(param.value)}`,
						)
						.join(", ")}) => ${formatTsType(binding.returns)}`;
		return {
			name: declaration.name,
			status: binding === undefined ? "needs-facts" : "bound",
			c: formatCFunction(declaration),
			...(signature === undefined ? {} : { ts: signature }),
			...(declaration.doc === undefined ? {} : { doc: declaration.doc }),
			location: declaration.location,
			...(declaration.inline ? { inline: true as const } : {}),
			...(declaration.attributes.length === 0
				? {}
				: { attributes: declaration.attributes }),
			params,
			returns,
			...(gaps === undefined ? {} : { gaps }),
		};
	});
	const types = [...plan.records.values()]
		.filter((entry) => entry.record.library)
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.map((entry): TypeInspection => ({
			name: entry.name,
			c: entry.spelling,
			ts: `{ ${entry.fields.map((field) => `${field.name}: ${formatTsType(field.value)}`).join("; ")} }`,
			...(entry.record.doc === undefined ? {} : { doc: entry.record.doc }),
			fields: entry.fields.map((field) => {
				const doc = entry.record.fields.find(
					(candidate) => candidate.name === field.name,
				)?.doc;
				return {
					name: field.name,
					c: formatCDeclaration(field.type),
					ts: formatTsType(field.value),
					...(doc === undefined ? {} : { doc }),
				};
			}),
		}));
	const constants = plan.constants.map((constant): ConstantInspection => ({
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
		summary: {
			functions: model.functions.length,
			bound: plan.functions.length,
			needFacts: plan.unbound.length,
			types: types.length,
			constants: constants.length,
			skippedConstants: plan.skippedConstants.length,
		},
		functions,
		types,
		constants,
		skippedConstants: plan.skippedConstants,
	};
}

/** A short human summary; `--json` carries the full detail. */
export function formatInspection(inspection: FfiInspection): string {
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
		lines.push("", "Functions that need facts:");
		for (const entry of needFacts) {
			for (const gap of entry.gaps ?? [])
				lines.push(`  ${entry.name} ${gap.at}: ${gap.reason}`);
		}
	}
	if (inspection.skippedConstants.length > 0) {
		lines.push("", "Macros and constants without a mapping:");
		for (const entry of inspection.skippedConstants)
			lines.push(`  ${entry.name}: ${entry.reason}`);
	}
	return lines.join("\n");
}
