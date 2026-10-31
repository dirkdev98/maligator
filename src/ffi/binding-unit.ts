import type {
	BindingPlan,
	BoundFunction,
	JsValue,
	MappedConstant,
	MappedRecord,
} from "./binding-plan.ts";
import type { CModel } from "./c-model.ts";
import { resolveCType } from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { CType } from "./c-type.ts";

/** The generated C that implements `maligator:ffi/<library>`. */
export interface BindingUnit {
	readonly library: string;
	readonly specifier: string;
	/** The host installer symbol the program image references. */
	readonly installer: string;
	/** Export names in byte order, matching the installer's table. */
	readonly exports: ReadonlyArray<string>;
	readonly source: string;
}

export function ffiModuleSpecifier(library: string): string {
	return `maligator:ffi/${library}`;
}

export function ffiInstallerSymbol(library: string): string {
	return `mal_ffi_install_${library}`;
}

function byteOrder(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function cString(text: string): string {
	return JSON.stringify(text);
}

/** A declaration of `name` with top-level qualifiers removed, so it can be assigned. */
function localDeclaration(type: CType, name: string): string {
	return formatCDeclaration(
		"const" in type && type.const === true ? { ...type, const: undefined } : type,
		name,
	);
}

/**
 * Emits C for one library. Every local and helper name starts with `mal_`, since
 * the library's headers are in scope and may define macros with common names.
 */
class BindingWriter {
	readonly #model: CModel;
	readonly #plan: BindingPlan;
	readonly #inputs = new Set<string>();
	readonly #outputs = new Set<string>();
	#counter = 0;

	constructor(model: CModel, plan: BindingPlan) {
		this.#model = model;
		this.#plan = plan;
	}

	#fresh(prefix: string): string {
		return `mal_${prefix}_${String(this.#counter++)}`;
	}

	#record(name: string): MappedRecord {
		const record = this.#plan.records.get(name);
		if (record === undefined) throw new Error(`binding plan has no record '${name}'`);
		return record;
	}

	/** Mark the record helpers a value needs, recursively through fields and arrays. */
	need(value: JsValue, direction: "input" | "output"): void {
		if (value.kind === "array") {
			this.need(value.of, direction);
			return;
		}
		if (value.kind !== "record") return;
		const set = direction === "input" ? this.#inputs : this.#outputs;
		if (set.has(value.name)) return;
		set.add(value.name);
		for (const field of this.#record(value.name).fields)
			this.need(field.value, direction);
	}

	/**
	 * Statements that convert the JavaScript value `source` into the C lvalue
	 * `target`. `fail` leaves the enclosing function after a pending throw.
	 */
	read(
		value: JsValue,
		type: CType,
		source: string,
		target: string,
		site: string,
		fail: string,
		strings: Array<string>,
	): Array<string> {
		const cast = (expression: string) =>
			`(${localDeclaration(type, "")}) (${expression})`;
		switch (value.kind) {
			case "integer": {
				const temporary = this.#fresh("integer");
				return [
					`int64_t ${temporary};`,
					`if (!mal_ffi_to_integer(vm, ${source}, ${value.bits}, ${value.signed}, ${site}, &${temporary})) ${fail}`,
					`${target} = ${cast(temporary)};`,
				];
			}
			case "bigint": {
				const temporary = this.#fresh("integer");
				const width = value.signed ? "int64" : "uint64";
				return [
					`${width}_t ${temporary};`,
					`if (!mal_ffi_to_${width}(vm, ${source}, ${site}, &${temporary})) ${fail}`,
					`${target} = ${cast(temporary)};`,
				];
			}
			case "float": {
				const temporary = this.#fresh("number");
				return [
					`double ${temporary};`,
					`if (!mal_ffi_to_number(vm, ${source}, ${site}, &${temporary})) ${fail}`,
					`${target} = ${cast(temporary)};`,
				];
			}
			case "boolean": {
				const temporary = this.#fresh("boolean");
				return [
					`bool ${temporary};`,
					`if (!mal_ffi_to_boolean(vm, ${source}, ${site}, &${temporary})) ${fail}`,
					`${target} = ${temporary};`,
				];
			}
			case "string": {
				const temporary = this.#fresh("string");
				strings.push(temporary);
				return [
					`if (!mal_ffi_to_string(vm, ${source}, ${site}, &${temporary})) ${fail}`,
					`${target} = ${temporary}.data;`,
				];
			}
			case "record": {
				// A getter may return a fresh object that only this frame references.
				const held = this.#fresh("held");
				const roots = this.#fresh("roots");
				const converted = this.#fresh("converted");
				return [
					`MalValue ${held} = ${source};`,
					`MalFfiRoots ${roots};`,
					`mal_ffi_root(&${roots}, &${held}, 1);`,
					`bool ${converted} = mal_ffi_in_${value.name}(vm, ${held}, ${site}, &${target});`,
					`mal_ffi_unroot(&${roots});`,
					`if (!${converted}) ${fail}`,
				];
			}
			case "array": {
				const resolved = resolveCType(this.#model, type);
				if (resolved.kind !== "array")
					throw new Error("array mapping without an array type");
				const index = this.#fresh("index");
				const element = this.#fresh("element");
				return [
					`for (int32_t ${index} = 0; ${index} < ${value.length}; ${index}++) {`,
					`\tMalValue ${element};`,
					`\tif (!mal_ffi_element(vm, ${source}, ${index}, ${value.length}, ${site}, &${element})) ${fail}`,
					...this.read(
						value.of,
						resolved.of,
						element,
						`${target}[${index}]`,
						site,
						fail,
						strings,
					).map((line) => `\t${line}`),
					"}",
				];
			}
			case "undefined":
				throw new Error("void has no input conversion");
		}
	}

	/** An expression that converts the C value `expression` into a JavaScript value. */
	write(value: JsValue, expression: string): string {
		switch (value.kind) {
			case "undefined":
				return "mal_ffi_undefined()";
			case "boolean":
				return `mal_ffi_from_boolean(${expression})`;
			case "integer":
				return value.signed || value.bits < 32
					? `mal_ffi_from_int32((int32_t) (${expression}))`
					: `mal_ffi_from_number((double) (${expression}))`;
			case "float":
				return `mal_ffi_from_number((double) (${expression}))`;
			case "bigint":
				return value.signed
					? `mal_ffi_from_int64(vm, (int64_t) (${expression}))`
					: `mal_ffi_from_uint64(vm, (uint64_t) (${expression}))`;
			case "string":
				return `mal_ffi_from_string(vm, ${expression})`;
			case "record":
				return `mal_ffi_out_${value.name}(vm, ${expression})`;
			case "array":
				throw new Error("arrays are written field by field");
		}
	}

	/** Statements that store the C value `expression` into the rooted container. */
	#store(
		value: JsValue,
		expression: string,
		store: (element: string) => string,
	): Array<string> {
		if (value.kind !== "array") {
			return [
				`mal_element = ${this.write(value, expression)};`,
				`if (mal_ffi_threw(vm) || !${store("mal_element")}) goto mal_done;`,
			];
		}
		const array = this.#fresh("array");
		const roots = this.#fresh("roots");
		const index = this.#fresh("index");
		return [
			`MalValue ${array} = mal_ffi_new_array(vm, ${value.length});`,
			`if (mal_ffi_threw(vm)) goto mal_done;`,
			`MalFfiRoots ${roots};`,
			`mal_ffi_root(&${roots}, &${array}, 1);`,
			`for (int32_t ${index} = 0; ${index} < ${value.length}; ${index}++) {`,
			...this.#store(
				value.of,
				`${expression}[${index}]`,
				(element) => `mal_ffi_set_element(vm, ${array}, ${index}, ${element})`,
			).map(
				(line) =>
					`\t${line.replace("goto mal_done;", `{ mal_ffi_unroot(&${roots}); goto mal_done; }`)}`,
			),
			"}",
			`mal_ffi_unroot(&${roots});`,
			`if (!${store(array)}) goto mal_done;`,
		];
	}

	recordHelpers(): Array<string> {
		const lines: Array<string> = [];
		const inputs = [...this.#inputs].sort(byteOrder);
		const outputs = [...this.#outputs].sort(byteOrder);
		for (const name of inputs) {
			const record = this.#record(name);
			lines.push(
				`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${record.spelling} *mal_out);`,
			);
		}
		for (const name of outputs) {
			lines.push(
				`static MalValue mal_ffi_out_${name}(MalVm *vm, ${this.#record(name).spelling} mal_value);`,
			);
		}
		for (const name of inputs) {
			const record = this.#record(name);
			lines.push(
				"",
				`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${record.spelling} *mal_out) {`,
				"\tMalFfiSite mal_field_site = *mal_site;",
				"\tMalValue mal_field;",
			);
			for (const field of record.fields) {
				lines.push(
					`\tmal_field_site.field = ${cString(field.name)};`,
					`\tif (!mal_ffi_field(vm, mal_value, ${cString(field.name)}, mal_site, &mal_field)) return false;`,
					...this.read(
						field.value,
						field.type,
						"mal_field",
						`mal_out->${field.name}`,
						"&mal_field_site",
						"return false;",
						[],
					).map((line) => `\t${line}`),
				);
			}
			lines.push("\treturn true;", "}");
		}
		for (const name of outputs) {
			const record = this.#record(name);
			lines.push(
				"",
				`static MalValue mal_ffi_out_${name}(MalVm *vm, ${record.spelling} mal_value) {`,
				"\tMalValue mal_record = mal_ffi_new_record(vm);",
				"\tif (mal_ffi_threw(vm)) return mal_ffi_undefined();",
				"\tMalFfiRoots mal_roots;",
				"\tmal_ffi_root(&mal_roots, &mal_record, 1);",
				"\tMalValue mal_element;",
			);
			for (const field of record.fields) {
				lines.push(
					...this.#store(
						field.value,
						`mal_value.${field.name}`,
						(element) =>
							`mal_ffi_set_field(vm, mal_record, ${cString(field.name)}, ${element})`,
					).map((line) => `\t${line}`),
				);
			}
			lines.push(
				"mal_done:",
				"\tmal_ffi_unroot(&mal_roots);",
				"\treturn mal_ffi_threw(vm) ? mal_ffi_undefined() : mal_record;",
				"}",
			);
		}
		return lines;
	}

	function(binding: BoundFunction): Array<string> {
		const name = binding.name;
		const body: Array<string> = [];
		const strings: Array<string> = [];
		const locals: Array<string> = [];
		binding.params.forEach((param, index) => {
			const local = `mal_argument_${String(index)}`;
			const site = `mal_site_${String(index)}`;
			locals.push(
				`${localDeclaration(param.type, local)};`,
				`static const MalFfiSite ${site} = { ${cString(name)}, ${cString(param.name)}, nullptr };`,
			);
			body.push(
				...this.read(
					param.value,
					param.type,
					`mal_argc > ${String(index)} ? mal_args[${String(index)}] : mal_ffi_undefined()`,
					local,
					`&${site}`,
					"goto mal_done;",
					strings,
				),
			);
		});
		const call = `${name}(${binding.params.map((_, index) => `mal_argument_${String(index)}`).join(", ")})`;
		if (binding.returns.kind === "undefined") body.push(`${call};`);
		else {
			locals.push(`${localDeclaration(binding.declaration.returns, "mal_return")};`);
			body.push(
				`mal_return = ${call};`,
				`mal_result = ${this.write(binding.returns, "mal_return")};`,
			);
		}
		return [
			`static MalValue mal_ffi_function_${name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
			"\t(void) vm;",
			"\t(void) mal_this;",
			"\t(void) mal_new_target;",
			"\t(void) mal_callee;",
			...(binding.params.length === 0
				? ["\t(void) mal_args;", "\t(void) mal_argc;"]
				: []),
			"\tMalValue mal_result = mal_ffi_undefined();",
			...strings.map((temporary) => `\tMalFfiString ${temporary} = {0};`),
			...locals.map((line) => `\t${line}`),
			...body.map((line) => `\t${line}`),
			...(binding.params.length === 0 && strings.length === 0 ? [] : ["mal_done:"]),
			...strings.map((temporary) => `\tmal_ffi_string_release(&${temporary});`),
			"\treturn mal_result;",
			"}",
		];
	}

	constant(constant: MappedConstant): Array<string> {
		return [
			`static MalValue mal_ffi_constant_${constant.name}(MalVm *vm) {`,
			"\t(void) vm;",
			`\treturn ${this.write(constant.value, `(${constant.name})`)};`,
			"}",
		];
	}
}

/** Generate the binding unit for every declaration the plan could map. */
export function generateBindingUnit(
	library: string,
	headers: ReadonlyArray<string>,
	model: CModel,
	plan: BindingPlan,
): BindingUnit {
	const writer = new BindingWriter(model, plan);
	for (const binding of plan.functions) {
		for (const param of binding.params) writer.need(param.value, "input");
		writer.need(binding.returns, "output");
	}
	for (const constant of plan.constants) writer.need(constant.value, "output");

	const functions = plan.functions.flatMap((binding) => [
		"",
		...writer.function(binding),
	]);
	const constants = plan.constants.flatMap((constant) => [
		"",
		...writer.constant(constant),
	]);
	const exports = [
		...plan.functions.map((binding) => ({
			name: binding.name,
			entry: `{ ${cString(binding.name)}, ${String(binding.params.length)}, mal_ffi_function_${binding.name}, nullptr }`,
		})),
		...plan.constants.map((constant) => ({
			name: constant.name,
			entry: `{ ${cString(constant.name)}, 0, nullptr, mal_ffi_constant_${constant.name} }`,
		})),
	].sort((left, right) => byteOrder(left.name, right.name));
	const specifier = ffiModuleSpecifier(library);
	const installer = ffiInstallerSymbol(library);
	const source = [
		`// Generated binding for ${specifier}.`,
		'#include "mal_ffi.h"',
		...headers.map((header) => `#include "${header}"`),
		"",
		...writer.recordHelpers(),
		...functions,
		...constants,
		"",
		"static const MalFfiExport mal_ffi_exports[] = {",
		...exports.map((entry) => `\t${entry.entry},`),
		"};",
		"",
		"static const MalFfiLibrary mal_ffi_library = {",
		`\t${cString(specifier)},`,
		"\tmal_ffi_exports,",
		`\t${String(exports.length)},`,
		"};",
		"",
		`void ${installer}(MalVm *vm, const MalHostInstallSlot *slots, int32_t count, const MalHostLaunchContext *launch) {`,
		"\t(void) launch;",
		"\tmal_ffi_install(vm, &mal_ffi_library, slots, count);",
		"}",
		"",
	].join("\n");
	return {
		library,
		specifier,
		installer,
		exports: exports.map((entry) => entry.name),
		source,
	};
}

/**
 * The resolver that images loaded from the wire format use to find each library's
 * installer by name. It replaces the runtime's empty weak default.
 */
export function generateInstallerRegistry(units: ReadonlyArray<BindingUnit>): string {
	return [
		"// Generated C library installer registry.",
		"#include <string.h>",
		'#include "mal_ffi.h"',
		"",
		...units.map(
			(unit) =>
				`void ${unit.installer}(MalVm *vm, const MalHostInstallSlot *slots, int32_t count, const MalHostLaunchContext *launch);`,
		),
		"",
		"MalFfiInstaller mal_ffi_resolve_installer(const char *name, size_t length) {",
		...units.map(
			(unit) =>
				`\tif (length == ${String(unit.installer.length)} && memcmp(name, ${cString(unit.installer)}, length) == 0) return ${unit.installer};`,
		),
		"\treturn nullptr;",
		"}",
		"",
	].join("\n");
}
