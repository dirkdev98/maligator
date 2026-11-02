import { createHash } from "node:crypto";
import type { BindingPlan, MappedConstant } from "./binding-plan.ts";
import { ffiModuleSpecifier } from "./binding-unit.ts";
import { formatTsParameters, formatTsResult, formatTsType } from "./inspect.ts";
import { FfiText } from "./text.ts";

function docComment(doc: FfiText | undefined, indent: string): Array<FfiText> {
	if (doc === undefined) return [];
	const escaped: Array<string> = [];
	let carry = "";
	for (const chunk of doc.chunks) {
		let text = carry + chunk;
		carry = text.endsWith("*") ? "*" : "";
		if (carry !== "") text = text.slice(0, -1);
		escaped.push(text.replaceAll("*/", "*\\/"));
	}
	escaped.push(carry);
	const lines = [...new FfiText(escaped).lines()];
	return lines.length === 1
		? [new FfiText([`${indent}/** `, ...lines[0]!.chunks, " */"])]
		: [
				new FfiText([`${indent}/**`]),
				...lines.map((line) => new FfiText([`${indent} * `, ...line.chunks]).trimEnd()),
				new FfiText([`${indent} */`]),
			];
}

/** A literal type for a constant whose value the build already knows. */
function constantType(constant: MappedConstant): string {
	const known = constant.known;
	if (typeof known === "bigint") return `${known}n`;
	if (typeof known === "string") return JSON.stringify(known);
	if (typeof known === "number" && Number.isInteger(known)) return String(known);
	return formatTsType(constant.value);
}

function moduleDeclaration(library: string, plan: BindingPlan): Array<string | FfiText> {
	const lines: Array<string | FfiText> = [
		`declare module ${JSON.stringify(ffiModuleSpecifier(library))} {`,
	];
	if (plan.handles.size > 0) lines.push("\tconst maligatorFfiHandle: unique symbol;");
	for (const tagged of plan.tagged.values()) {
		if (tagged.alias !== undefined)
			lines.push(
				...docComment(tagged.record.doc, "\t"),
				`\texport type ${tagged.alias} = ${formatTsType({ kind: "tagged", name: tagged.name, tag: tagged.tag.name, cases: tagged.cases.map((entry) => ({ literal: entry.literal, value: { kind: "record", name: entry.record.name } })) })};`,
			);
	}
	for (const union of [...plan.unions.values()].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		if (union.alias !== undefined)
			lines.push(
				...docComment(union.record.doc, "\t"),
				`\texport type ${union.alias} = ${formatTsType(union.member.value)};`,
			);
	}
	const records = [...plan.records.values()].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	for (const record of records) {
		if (record.fields.length === 0) {
			lines.push(
				...docComment(record.record.doc, "\t"),
				`\t${record.private === true ? "" : "export "}type ${record.name} = object;`,
			);
			continue;
		}
		lines.push(
			...docComment(record.record.doc, "\t"),
			`\t${record.private === true ? "" : "export "}interface ${record.name} {`,
		);
		for (const field of record.fields) {
			lines.push(
				...docComment(field.doc, "\t\t"),
				`\t\t${field.name}: ${formatTsType(field.value)};`,
			);
		}
		lines.push("\t}");
	}
	for (const handle of plan.handles.values()) {
		const fieldLines = (
			field: (typeof handle.fields)[number],
		): Array<FfiText | string> => [
			...docComment(field.doc, "\t\t"),
			`\t\treadonly ${field.name}: ${formatTsType(field.value)};`,
		];
		const callables = handle.fields
			.filter((field) => field.value.kind === "callable")
			.flatMap(fieldLines);
		const values = [
			...handle.fields
				.filter((field) => field.value.kind !== "callable")
				.flatMap(fieldLines),
			...handle.managedFields.flatMap((field) => [
				...docComment(field.doc, "\t\t"),
				`\t\tget ${field.name}(): ${field.kind === "string" ? "string" : "Uint8Array"} | null;`,
				`\t\tset ${field.name}(value: ${field.kind === "string" ? "string" : "ArrayBuffer | ArrayBufferView"} | null);`,
			]),
		];
		lines.push(
			...docComment(handle.doc, "\t"),
			`\texport interface ${handle.name}${handle.views.length === 0 ? "" : ` extends ${handle.views.join(", ")}`} {`,
			`\t\treadonly [maligatorFfiHandle]: { ${[handle.name, ...handle.views].map((name) => `readonly ${name}: true`).join("; ")} };`,
			"\t\treadonly [Symbol.toStringTag]: string;",
			`\t\t/** Close the handle${handle.destroy === undefined ? "" : `, releasing an owned resource with ${handle.destroy.name}`}.${handle.destroy?.success === undefined ? "" : " Failed C cleanup throws and leaves it open for retry."} */`,
			"\t\t[Symbol.dispose](): void;",
		);
		lines.push(...callables);
		// Caller storage factories guarantee state accessors; canonical pointer aliases may predate them.
		if (handle.allocator === undefined) lines.push(...values);
		lines.push("\t}");
		if (handle.allocator !== undefined)
			lines.push(
				"\t/** Allocate zeroed caller storage. C initialization and cleanup remain explicit. */",
				`\texport function ${handle.allocator}(${handle.trailing === undefined ? "" : "length: bigint"}): ${handle.name}${values.length === 0 ? ";" : " & {"}`,
				...(values.length === 0 ? [] : [...values, "\t};"]),
			);
	}
	for (const binding of plan.functions) {
		lines.push(
			...docComment(binding.declaration.doc, "\t"),
			`\texport function ${binding.name}(${formatTsParameters(binding)}): ${formatTsResult(binding)};`,
		);
		if (binding.async !== undefined) {
			lines.push(
				...docComment(new FfiText([`Run ${binding.name} on a worker thread.`]), "\t"),
				`\texport function ${binding.async}(${formatTsParameters(binding)}): Promise<${formatTsResult(binding)}>;`,
			);
		}
	}
	for (const constant of plan.constants) {
		lines.push(
			...docComment(constant.doc, "\t"),
			`\texport const ${constant.name}: ${constantType(constant)};`,
		);
	}
	lines.push("}");
	return lines;
}

type DeclaredLibraries = ReadonlyArray<{
	readonly name: string;
	readonly plan: BindingPlan;
}>;

function* declarationBody(libraries: DeclaredLibraries): Generator<string> {
	for (let index = 0; index < libraries.length; index++) {
		if (index > 0) yield "\n\n";
		const library = libraries[index]!;
		const lines = moduleDeclaration(library.name, library.plan);
		for (let line = 0; line < lines.length; line++) {
			if (line > 0) yield "\n";
			const text = lines[line]!;
			if (typeof text === "string") yield text;
			else yield* text.chunks;
		}
	}
}

function declarationDigest(libraries: DeclaredLibraries): string {
	const digest = createHash("sha256");
	for (const chunk of declarationBody(libraries)) digest.update(chunk);
	return digest.digest("hex");
}

/** Ambient module declarations preserve header documentation in bounded output fragments. */
export function* generateDeclarations(libraries: DeclaredLibraries): Generator<string> {
	yield "// Generated by `maligator ffi types` from the libraries' headers. Do not edit.\n";
	yield `// Digest ${declarationDigest(libraries)}\n\n`;
	yield* declarationBody(libraries);
	yield "\n";
}

/** Compare the generated digest with a declaration file's initial header. */
export function declarationsCurrent(
	header: string,
	libraries: DeclaredLibraries,
): boolean {
	return /^\/\/ Digest (\S+)$/m.exec(header)?.[1] === declarationDigest(libraries);
}
