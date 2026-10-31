import type { FfiDirectEntry, FfiDirectResult } from "../build-config-values.ts";
import type {
	BindingPlan,
	BoundFunction,
	HandleType,
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
	/** The direct entry of each function export, by export name. */
	readonly direct: Readonly<Record<string, FfiDirectEntry>>;
	readonly source: string;
}

export function ffiModuleSpecifier(library: string): string {
	return `maligator:ffi/${library}`;
}

export function ffiInstallerSymbol(library: string): string {
	return `mal_ffi_install_${library}`;
}

/** The library name's length keeps `a` + `b_c` apart from `a_b` + `c`. */
function directSymbol(library: string, name: string): string {
	return `mal_ffi_direct${String(library.length)}_${library}_${name}`;
}

/** The primitive a binding returns, which lets compiled callers keep it unboxed. */
function directResult(binding: BoundFunction): FfiDirectResult | undefined {
	if (binding.outputs.length > 0) return undefined;
	const value = binding.returns;
	switch (value.kind) {
		case "integer":
			return value.signed
				? {
						kind: "integer",
						minimum: -(2 ** (value.bits - 1)),
						maximum: 2 ** (value.bits - 1) - 1,
					}
				: { kind: "integer", minimum: 0, maximum: 2 ** value.bits - 1 };
		case "float":
			return { kind: "number" };
		case "boolean":
		case "undefined":
			return { kind: value.kind };
		default:
			return undefined;
	}
}

/** Inputs whose conversion cannot run JavaScript, so their values need no roots. */
const SCALAR_INPUTS: ReadonlySet<JsValue["kind"]> = new Set([
	"boolean",
	"integer",
	"float",
	"bigint",
]);

/**
 * An external entry that native code calls with the arguments themselves, skipping
 * the function object and argument array of an ordinary call. Arguments a getter or
 * callback could outlive are rooted for the call, as the call path roots them.
 */
function directEntry(library: string, binding: BoundFunction): Array<string> {
	const arity = binding.params.length;
	const symbol = directSymbol(library, binding.name);
	const parameters = Array.from(
		{ length: arity },
		(_, index) => `, MalValue mal_a${String(index)}`,
	);
	const invoke = (args: string) =>
		`mal_ffi_function_${binding.name}(vm, mal_ffi_undefined(), ${args}, ${String(arity)}, mal_ffi_undefined(), mal_ffi_undefined())`;
	if (arity === 0) {
		return ["", `MalValue ${symbol}(MalVm *vm) {`, `	return ${invoke("nullptr")};`, "}"];
	}
	const rooted = binding.params.some((param) => !SCALAR_INPUTS.has(param.value.kind));
	return [
		"",
		`MalValue ${symbol}(MalVm *vm${parameters.join("")}) {`,
		`	MalValue mal_direct_args[${String(arity)}] = { ${Array.from({ length: arity }, (_, index) => `mal_a${String(index)}`).join(", ")} };`,
		...(rooted
			? [
					"	MalFfiRoots mal_direct_roots;",
					`	mal_ffi_root(&mal_direct_roots, mal_direct_args, ${String(arity)});`,
					`	MalValue mal_direct_result = ${invoke("mal_direct_args")};`,
					"	mal_ffi_unroot(&mal_direct_roots);",
					"	return mal_direct_result;",
				]
			: [`	return ${invoke("mal_direct_args")};`]),
		"}",
	];
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

	#handle(name: string): HandleType {
		const handle = this.#plan.handles.get(name);
		if (handle === undefined) throw new Error(`binding plan has no handle '${name}'`);
		return handle;
	}

	/** Mark the record helpers a value needs, recursively through fields and arrays. */
	need(value: JsValue, direction: "input" | "output"): void {
		if (value.kind === "array" || value.kind === "sequence") {
			this.need(value.of, direction);
			return;
		}
		if (value.kind === "callback") {
			// A callback converts the other way: C arguments out, its result in.
			for (const param of value.params) if (param !== "data") this.need(param, "output");
			this.need(value.returns, "input");
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
			case "handle": {
				const temporary = this.#fresh("handle");
				return [
					`void *${temporary};`,
					`if (!mal_ffi_to_handle(vm, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${temporary})) ${fail}`,
					value.pass === "copy"
						? `${target} = *(${this.#handle(value.name).spelling} *) ${temporary};`
						: `${target} = ${cast(temporary)};`,
				];
			}
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
			case "bytes":
			case "sequence":
				throw new Error("buffers and arrays convert with the count of their argument");
			case "callback":
				throw new Error("callbacks convert with their user data");
		}
	}

	/**
	 * An expression that converts the C value `expression` into a JavaScript value.
	 * A struct handle copies its struct, so `expression` must then be an lvalue.
	 */
	write(value: JsValue, expression: string): string {
		switch (value.kind) {
			case "handle": {
				const created = (address: string) =>
					`mal_ffi_new_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address}, ${value.owned})`;
				return value.pass === "copy"
					? created(`&(${expression})`)
					: `(${expression}) == nullptr ? mal_ffi_null() : ${created(`(void *) (${expression})`)}`;
			}
			case "undefined":
				return "mal_ffi_undefined()";
			case "bytes":
			case "sequence":
				throw new Error("buffer and array results convert with their count");
			case "callback":
				throw new Error("callbacks are parameters only");
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
	/**
	 * Statements that convert the C value `expression` into `target`, a rooted
	 * slot. Arrays fill a new array element by element.
	 */
	#produce(value: JsValue, expression: string, target: string): Array<string> {
		if (value.kind !== "array") {
			return [
				`${target} = ${this.write(value, expression)};`,
				"if (mal_ffi_threw(vm)) goto mal_done;",
			];
		}
		const element = this.#fresh("element");
		const roots = this.#fresh("roots");
		const index = this.#fresh("index");
		const stored = this.#fresh("stored");
		return [
			`${target} = mal_ffi_new_array(vm, ${value.length});`,
			"if (mal_ffi_threw(vm)) goto mal_done;",
			`for (int32_t ${index} = 0; ${index} < ${value.length}; ${index}++) {`,
			`\tMalValue ${element} = mal_ffi_undefined();`,
			`\tMalFfiRoots ${roots};`,
			`\tmal_ffi_root(&${roots}, &${element}, 1);`,
			...this.#produce(value.of, `${expression}[${index}]`, element).map(
				(line) =>
					`\t${line.replace("goto mal_done;", `{ mal_ffi_unroot(&${roots}); goto mal_done; }`)}`,
			),
			`\tbool ${stored} = mal_ffi_set_element(vm, ${target}, ${index}, ${element});`,
			`\tmal_ffi_unroot(&${roots});`,
			`\tif (!${stored}) goto mal_done;`,
			"}",
		];
	}

	/** Whether converting a C value allocates, so earlier results need rooting. */
	#allocates(value: JsValue): boolean {
		switch (value.kind) {
			case "integer":
			case "float":
			case "boolean":
			case "undefined":
				return false;
			default:
				return true;
		}
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
		for (const name of [...new Set([...inputs, ...outputs])].sort(byteOrder)) {
			const record = this.#record(name);
			lines.push(
				`static const char *const mal_ffi_record_fields_${name}[] = { ${record.fields.map((field) => cString(field.name)).join(", ")} };`,
				`static MalFfiRecordType mal_ffi_record_${name} = { mal_ffi_record_fields_${name}, ${String(record.fields.length)}, 0 };`,
			);
		}
		for (const name of inputs) {
			const record = this.#record(name);
			const count = String(record.fields.length);
			lines.push(
				"",
				`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${record.spelling} *mal_out) {`,
				`\tMalValue mal_fields[${count}] = {};`,
				"\tMalFfiRoots mal_roots;",
				`\tmal_ffi_root(&mal_roots, mal_fields, ${count});`,
				`\tbool mal_ok = mal_ffi_record_fields(vm, mal_value, &mal_ffi_record_${name}, mal_site, mal_fields);`,
				"\tif (!mal_ok) goto mal_done;",
				"\tMalFfiSite mal_field_site = *mal_site;",
			);
			record.fields.forEach((field, index) => {
				lines.push(
					`\tmal_field_site.field = ${cString(field.name)};`,
					...this.read(
						field.value,
						field.type,
						`mal_fields[${String(index)}]`,
						`mal_out->${field.name}`,
						"&mal_field_site",
						"{ mal_ok = false; goto mal_done; }",
						[],
					).map((line) => `\t${line}`),
				);
			});
			lines.push("mal_done:", "\tmal_ffi_unroot(&mal_roots);", "\treturn mal_ok;", "}");
		}
		for (const name of outputs) {
			const record = this.#record(name);
			const count = record.fields.length;
			const rooted = record.fields.some((field) => this.#allocates(field.value));
			lines.push(
				"",
				`static MalValue mal_ffi_out_${name}(MalVm *vm, ${record.spelling} mal_value) {`,
				`\tMalValue mal_values[${String(count)}] = {};`,
				"\tMalValue mal_record = mal_ffi_undefined();",
				...(rooted
					? [
							"\tMalFfiRoots mal_roots;",
							`\tmal_ffi_root(&mal_roots, mal_values, ${String(count)});`,
						]
					: []),
			);
			record.fields.forEach((field, index) => {
				lines.push(
					...this.#produce(
						field.value,
						`mal_value.${field.name}`,
						`mal_values[${String(index)}]`,
					).map((line) => `\t${line}`),
				);
			});
			lines.push(
				`\tmal_record = mal_ffi_new_record(vm, &mal_ffi_record_${name}, mal_values);`,
				"\tgoto mal_done;",
				"mal_done:",
				...(rooted ? ["\tmal_ffi_unroot(&mal_roots);"] : []),
				"\treturn mal_ffi_threw(vm) ? mal_ffi_undefined() : mal_record;",
				"}",
			);
		}
		return lines;
	}

	/** The descriptor of each handle type: its destroy wrapper and field accessors. */
	handleTypes(): Array<string> {
		const lines: Array<string> = [];
		for (const handle of this.#plan.handles.values()) {
			const name = handle.name;
			let destroy = "nullptr";
			if (handle.destroy !== undefined) {
				destroy = `mal_ffi_destroy_${name}`;
				const argument =
					handle.destroy.takes === "value"
						? `*(${handle.spelling} *) mal_value`
						: `(${handle.spelling} *) mal_value`;
				lines.push(
					"",
					`static void ${destroy}(void *mal_value) {`,
					`\t${handle.destroy.name}(${argument});`,
					"}",
				);
			}
			for (const field of handle.fields) {
				lines.push(
					"",
					`static MalValue mal_ffi_get_${name}_${field.name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
					"\t(void) mal_args;",
					"\t(void) mal_argc;",
					"\t(void) mal_new_target;",
					"\t(void) mal_callee;",
					`\tstatic const MalFfiSite mal_site = { ${cString(`${name}.${field.name}`)}, "this", nullptr };`,
					"\tvoid *mal_handle;",
					`\tif (!mal_ffi_to_handle(vm, mal_this, &mal_ffi_type_${name}, false, &mal_site, &mal_handle)) return mal_ffi_undefined();`,
					`\t${handle.spelling} *mal_value = mal_handle;`,
					`\treturn ${this.write(field.value, `mal_value->${field.name}`)};`,
					"}",
				);
			}
			const fields = handle.fields.length === 0 ? "nullptr" : `mal_ffi_fields_${name}`;
			if (handle.fields.length > 0) {
				lines.push(
					"",
					`static const MalFfiField ${fields}[] = {`,
					...handle.fields.map(
						(field) => `\t{ ${cString(field.name)}, mal_ffi_get_${name}_${field.name} },`,
					),
					"};",
				);
			}
			lines.push(
				"",
				`static const MalFfiHandleType mal_ffi_type_${name} = {`,
				`\t${cString(name)},`,
				`\t${handle.representation === "struct" ? `sizeof(${handle.spelling})` : "0"},`,
				`\t${destroy},`,
				`\t${handle.collect},`,
				`\t${fields},`,
				`\t${String(handle.fields.length)},`,
				"};",
			);
		}
		return lines;
	}

	/**
	 * Statements that store a result or output in `target` and then release the C
	 * memory when the caller owns it, even after a conversion threw. `pending` says
	 * whether a callback or an earlier conversion may have left a throw pending.
	 */
	#owned(
		value: JsValue,
		expression: string,
		target: string,
		count: string | undefined,
		site: string,
		pending: boolean,
	): Array<string> {
		const release =
			"free" in value && value.free !== undefined
				? [`if ((${expression}) != nullptr) ${value.free}((void *) (${expression}));`]
				: [];
		const unlessThrew = pending ? "if (!mal_ffi_threw(vm)) " : "";
		if (value.kind === "bytes") {
			return [
				`${unlessThrew}${target} = (${expression}) == nullptr ? mal_ffi_null() : mal_ffi_from_bytes(vm, ${expression}, (size_t) (${count}));`,
				...release,
			];
		}
		if (value.kind === "sequence") {
			const array = this.#fresh("array");
			const roots = this.#fresh("roots");
			const index = this.#fresh("index");
			return [
				"if (!mal_ffi_threw(vm)) {",
				`\tif ((${expression}) == nullptr) ${target} = mal_ffi_null();`,
				`\telse if (mal_ffi_check_count(vm, (size_t) (${count}), 32, true, ${site})) {`,
				`\t\tMalValue ${array} = mal_ffi_new_array(vm, (int32_t) (${count}));`,
				`\t\tMalFfiRoots ${roots};`,
				`\t\tmal_ffi_root(&${roots}, &${array}, 1);`,
				`\t\tfor (int32_t ${index} = 0; !mal_ffi_threw(vm) && ${index} < (int32_t) (${count}); ${index}++) {`,
				`\t\t\tmal_ffi_set_element(vm, ${array}, ${index}, ${this.write(value.of, `(${expression})[${index}]`)});`,
				"\t\t}",
				`\t\tmal_ffi_unroot(&${roots});`,
				`\t\t${target} = ${array};`,
				"\t}",
				"}",
				...release,
			];
		}
		return [`${unlessThrew}${target} = ${this.write(value, expression)};`, ...release];
	}

	/**
	 * A C function of the callback's type that converts its arguments, calls the
	 * JavaScript function its user data names, and converts the result back. After
	 * an exception, later calls return zero without running JavaScript.
	 */
	#trampoline(
		name: string,
		value: Extract<JsValue, { kind: "callback" }>,
		owner: string,
	): Array<string> {
		const type = value.type;
		const params = type.params.map((param, index) =>
			formatCDeclaration(param, `mal_c${String(index)}`),
		);
		const data = value.params.indexOf("data");
		const inputs = value.params.flatMap((param, index) =>
			param === "data" ? [] : [{ value: param, index }],
		);
		const returns = value.returns.kind !== "undefined";
		const count = String(inputs.length);
		return [
			"",
			`static ${formatCDeclaration(type.returns, `${name}(${params.length === 0 ? "void" : params.join(", ")})`)} {`,
			`\tMalFfiCallback *mal_callback = mal_c${String(data)};`,
			...(returns ? [`\t${localDeclaration(type.returns, "mal_return")} = {};`] : []),
			...(value.kept
				? [
						"\tMalVm *vm = mal_ffi_callback_vm(mal_callback);",
						// A library may call back after the VM is gone; it gets a zero result.
						`\tif (vm == nullptr) return${returns ? " mal_return" : ""};`,
					]
				: ["\tMalVm *vm = mal_callback->vm;"]),
			`\tstatic const MalFfiSite mal_site = { ${cString(owner)}, "callback result", nullptr };`,
			"\t(void) mal_site;",
			`\tMalValue mal_values[${inputs.length === 0 ? "1" : count}] = {};`,
			"\tMalValue mal_result = mal_ffi_undefined();",
			"\tMalFfiRoots mal_roots;",
			`\tmal_ffi_root(&mal_roots, mal_values, ${count});`,
			"\tif (mal_ffi_threw(vm)) goto mal_done;",
			...inputs.flatMap((input, position) =>
				this.#produce(
					input.value,
					`mal_c${String(input.index)}`,
					`mal_values[${String(position)}]`,
				).map((line) => `\t${line}`),
			),
			`\tif (!mal_ffi_call(vm, mal_callback->function, mal_values, ${count}, &mal_result)) goto mal_done;`,
			...(returns
				? this.read(
						value.returns,
						type.returns,
						"mal_result",
						"mal_return",
						"&mal_site",
						"goto mal_done;",
						[],
					).map((line) => `\t${line}`)
				: ["\t(void) mal_result;"]),
			"mal_done:",
			"\tmal_ffi_unroot(&mal_roots);",
			returns ? "\treturn mal_return;" : "\treturn;",
			"}",
		];
	}

	function(binding: BoundFunction): Array<string> {
		const name = binding.name;
		const declaration = binding.declaration;
		const locals: Array<string> = [];
		const body: Array<string> = [];
		/** Buffers resolve last: nothing may run JavaScript between them and the call. */
		const buffers: Array<string> = [];
		/** Kept callbacks, then the arguments that route to them, after the buffers. */
		const keeps: Array<string> = [];
		const kept: Array<string> = [];
		const keptCallback = (index: number): boolean => {
			const entry = binding.arguments[index];
			const value =
				entry?.kind === "input" ? binding.params[entry.param]?.value : undefined;
			return value?.kind === "callback" && value.kept;
		};
		const cleanup: Array<string> = [];
		const strings: Array<string> = [];
		const trampolines: Array<string> = [];
		const argument = (param: number) =>
			`mal_argc > ${String(param)} ? mal_args[${String(param)}] : mal_ffi_undefined()`;
		binding.params.forEach((param, index) => {
			locals.push(
				`static const MalFfiSite mal_site_${String(index)} = { ${cString(name)}, ${cString(param.name)}, nullptr };`,
			);
		});
		locals.push(
			`static const MalFfiSite mal_site_result = { ${cString(name)}, "result", nullptr };`,
			"(void) mal_site_result;",
		);
		const countOf = (counted: number): { index: number; type: CType } | undefined => {
			const index = binding.arguments.findIndex(
				(entry) => entry.kind === "count" && entry.of === counted,
			);
			return index < 0 ? undefined : { index, type: declaration.params[index]!.type };
		};
		const setCount = (
			counted: number,
			count: string,
			site: string,
			into: Array<string>,
		) => {
			const target = countOf(counted);
			if (target === undefined) return;
			const integer = resolveCType(this.#model, target.type);
			const bits =
				integer.kind === "integer"
					? (this.#model.target.sizes[integer.name] ?? 4) * 8
					: 32;
			const signed = integer.kind === "integer" && !integer.name.startsWith("unsigned");
			into.push(
				`if (!mal_ffi_check_count(vm, (size_t) (${count}), ${bits}, ${signed}, ${site})) goto mal_done;`,
				`mal_argument_${String(target.index)} = (${localDeclaration(target.type, "")}) (${count});`,
			);
		};
		binding.arguments.forEach((entry, index) => {
			const param = declaration.params[index]!;
			const local = `mal_argument_${String(index)}`;
			locals.push(`${localDeclaration(param.type, local)};`);
			const resolved = resolveCType(this.#model, param.type);
			const pointee = resolved.kind === "pointer" ? resolved.to : param.type;
			switch (entry.kind) {
				case "count":
					return;
				case "result-count":
					locals.push(`${localDeclaration(pointee, "mal_count")} = {};`);
					body.push(`${local} = &mal_count;`);
					return;
				case "constant":
					body.push(`${local} = ${entry.expression};`);
					return;
				case "callback-data":
					if (keptCallback(entry.of))
						kept.push(`${local} = mal_kept_${String(entry.of)};`);
					else body.push(`${local} = &mal_callback_${String(entry.of)};`);
					return;
				case "callback-release":
					kept.push(
						`${local} = mal_kept_${String(entry.of)} == nullptr ? nullptr : mal_ffi_release;`,
					);
					return;
				case "out":
				case "inout": {
					const output = `mal_output_${String(entry.output)}`;
					locals.push(`${localDeclaration(pointee, output)} = {};`);
					if (entry.kind === "inout") {
						body.push(
							...this.read(
								binding.params[entry.param]!.value,
								pointee,
								argument(entry.param),
								output,
								`&mal_site_${String(entry.param)}`,
								"goto mal_done;",
								strings,
							),
						);
					}
					body.push(`${local} = &${output};`);
					return;
				}
				case "input": {
					const value = binding.params[entry.param]!.value;
					const site = `&mal_site_${String(entry.param)}`;
					const source = argument(entry.param);
					if (value.kind === "bytes") {
						locals.push(
							`void *mal_bytes_${String(index)};`,
							`size_t mal_bytes_length_${String(index)};`,
							`void *mal_pin_${String(index)} = nullptr;`,
						);
						cleanup.push(`mal_ffi_unpin(mal_pin_${String(index)});`);
						buffers.push(
							`if (!mal_ffi_to_bytes(vm, ${source}, ${value.nullable}, ${site}, &mal_bytes_${String(index)}, &mal_bytes_length_${String(index)}, &mal_pin_${String(index)})) goto mal_done;`,
							`${local} = (${localDeclaration(param.type, "")}) mal_bytes_${String(index)};`,
						);
						setCount(index, `mal_bytes_length_${String(index)}`, site, buffers);
						return;
					}
					if (value.kind === "callback" && value.kept) {
						const trampoline = `mal_ffi_callback_${name}_${String(index)}`;
						const context = `mal_kept_${String(index)}`;
						trampolines.push(...this.#trampoline(trampoline, value, name));
						locals.push(`MalFfiCallback *${context} = nullptr;`);
						body.push(
							`if (!mal_ffi_to_function(vm, ${source}, ${value.nullable}, ${site})) goto mal_done;`,
						);
						// Kept last, after every conversion that can fail, so a failed call
						// never leaves a function rooted that no library holds.
						keeps.push(
							`if ((${source}) != mal_ffi_null()) {`,
							`\t${context} = mal_ffi_keep(vm, ${source});`,
							`\tif (${context} == nullptr) goto mal_done;`,
							"}",
						);
						kept.push(`${local} = ${context} == nullptr ? nullptr : ${trampoline};`);
						return;
					}
					if (value.kind === "callback") {
						const trampoline = `mal_ffi_callback_${name}_${String(index)}`;
						trampolines.push(...this.#trampoline(trampoline, value, name));
						locals.push(`MalFfiCallback mal_callback_${String(index)} = { vm, 0 };`);
						body.push(
							`if (!mal_ffi_to_function(vm, ${source}, ${value.nullable}, ${site})) goto mal_done;`,
							`mal_callback_${String(index)}.function = ${source};`,
							`${local} = ${value.nullable ? `(${source}) == mal_ffi_null() ? nullptr : ` : ""}${trampoline};`,
						);
						return;
					}
					if (value.kind === "sequence") {
						const elements = `mal_elements_${String(index)}`;
						const length = `mal_length_${String(index)}`;
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						// Each string element needs its own copy; the frame's string buffers hold one value each.
						const texts = value.of.kind === "string";
						const storage = `mal_storage_${String(index)}`;
						locals.push(
							`${localDeclaration(value.element, `*${elements}`)} = nullptr;`,
							`int32_t ${length} = 0;`,
							`alignas(max_align_t) unsigned char ${storage}[MAL_FFI_ARRAY_INLINE];`,
						);
						if (texts) {
							const freed = this.#fresh("index");
							cleanup.push(
								`if (${elements} != nullptr) for (int32_t ${freed} = 0; ${freed} < ${length}; ${freed}++) free((void *) ${elements}[${freed}]);`,
							);
						}
						cleanup.push(
							`if ((void *) ${elements} != (void *) ${storage}) free(${elements});`,
						);
						const text = this.#fresh("text");
						body.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &${length})) goto mal_done;`,
							`if (${length} > 0 && (size_t) ${length} <= sizeof(${storage}) / sizeof(*${elements})) {`,
							`\t${elements} = (void *) ${storage};`,
							// String elements must start null, since cleanup frees every slot.
							...(texts
								? [
										`\t__builtin_memset(${storage}, 0, (size_t) ${length} * sizeof(*${elements}));`,
									]
								: []),
							`} else if (${length} > 0) {`,
							`\t${elements} = calloc((size_t) ${length}, sizeof(*${elements}));`,
							`\tif (${elements} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
							"}",
							`for (int32_t ${position} = 0; ${position} < ${length}; ${position}++) {`,
							`\tMalValue ${element};`,
							`\tif (!mal_ffi_element(vm, ${source}, ${position}, ${length}, ${site}, &${element})) goto mal_done;`,
							...(texts
								? [
										`\tchar *${text};`,
										`\tif (!mal_ffi_to_owned_string(vm, ${element}, ${site}, &${text})) goto mal_done;`,
										`\t${elements}[${position}] = ${text};`,
									]
								: this.read(
										value.of,
										value.element,
										element,
										`${elements}[${position}]`,
										site,
										"goto mal_done;",
										strings,
									).map((line) => `\t${line}`)),
							"}",
							`${local} = (${localDeclaration(param.type, "")}) ${elements};`,
						);
						setCount(index, length, site, body);
						return;
					}
					body.push(
						...this.read(
							value,
							param.type,
							source,
							local,
							site,
							"goto mal_done;",
							strings,
						),
					);
					return;
				}
			}
		});
		const call = `${declaration.name}(${declaration.params.map((_, index) => `mal_argument_${String(index)}`).join(", ")})`;
		const closes =
			binding.closes === undefined
				? []
				: [`mal_ffi_close_handle(${argument(binding.closes)});`];
		const count =
			binding.resultCount === undefined
				? undefined
				: binding.arguments[binding.resultCount]?.kind === "result-count"
					? "mal_count"
					: `mal_argument_${String(binding.resultCount)}`;
		const after: Array<string> = [];
		if (binding.returns.kind === "undefined") {
			after.push(`${call};`, ...closes);
		} else {
			locals.push(`${localDeclaration(declaration.returns, "mal_return")};`);
			after.push(
				`mal_return = ${call};`,
				...closes,
				...this.#owned(
					binding.returns,
					"mal_return",
					"mal_result",
					count,
					"&mal_site_result",
					this.#plan.keepsCallbacks ||
						binding.params.some((param) => param.value.kind === "callback"),
				),
			);
		}
		if (binding.outputs.length > 0) {
			const fields = [
				...(binding.returns.kind === "undefined" ? [] : ["result"]),
				...binding.outputs.map((output) => output.name),
			];
			const first = fields.length - binding.outputs.length;
			locals.push(
				`static const char *const mal_output_fields[] = { ${fields.map(cString).join(", ")} };`,
				`static MalFfiRecordType mal_output_type = { mal_output_fields, ${String(fields.length)}, 0 };`,
			);
			after.push(
				`MalValue mal_outputs[${String(fields.length)}] = { ${first === 1 ? "mal_result" : "0"} };`,
				"MalFfiRoots mal_output_roots;",
				`mal_ffi_root(&mal_output_roots, mal_outputs, ${String(fields.length)});`,
			);
			binding.outputs.forEach((output, index) => {
				after.push(
					...this.#owned(
						output.value,
						`mal_output_${String(index)}`,
						`mal_outputs[${String(first + index)}]`,
						undefined,
						"&mal_site_result",
						true,
					),
				);
			});
			after.push(
				"if (!mal_ffi_threw(vm)) mal_result = mal_ffi_new_record(vm, &mal_output_type, mal_outputs);",
				"mal_ffi_unroot(&mal_output_roots);",
				"if (mal_ffi_threw(vm)) mal_result = mal_ffi_undefined();",
			);
		}
		return [
			...trampolines,
			"",
			`static MalValue mal_ffi_function_${name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
			"\t(void) vm;",
			"\t(void) mal_this;",
			"\t(void) mal_new_target;",
			"\t(void) mal_callee;",
			"\t(void) mal_args;",
			"\t(void) mal_argc;",
			"\tMalValue mal_result = mal_ffi_undefined();",
			...strings.flatMap((temporary) => [
				`\tMalFfiString ${temporary};`,
				`\t${temporary}.data = nullptr;`,
			]),
			...locals.map((line) => `\t${line}`),
			...body.map((line) => `\t${line}`),
			...buffers.map((line) => `\t${line}`),
			...keeps.map((line) => `\t${line}`),
			...kept.map((line) => `\t${line}`),
			...after.map((line) => `\t${line}`),
			"\tgoto mal_done;",
			"mal_done:",
			...strings.map((temporary) => `\tmal_ffi_string_release(&${temporary});`),
			...cleanup.map((line) => `\t${line}`),
			"\treturn mal_result;",
			"}",
		];
	}

	constant(constant: MappedConstant): Array<string> {
		const value = constant.value;
		// A struct handle copies from an lvalue.
		const copies = value.kind === "handle" && value.pass === "copy";
		return [
			`static MalValue mal_ffi_constant_${constant.name}(MalVm *vm) {`,
			"\t(void) vm;",
			...(copies
				? [
						`\t${this.#handle(value.name).spelling} mal_constant = (${constant.name});`,
						`\treturn ${this.write(value, "mal_constant")};`,
					]
				: [`\treturn ${this.write(value, `(${constant.name})`)};`]),
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
		for (const output of binding.outputs) writer.need(output.value, "output");
		writer.need(binding.returns, "output");
	}
	for (const constant of plan.constants) writer.need(constant.value, "output");
	for (const handle of plan.handles.values()) {
		for (const field of handle.fields) writer.need(field.value, "output");
	}

	const functions = plan.functions.flatMap((binding) => [
		"",
		...writer.function(binding),
		...directEntry(library, binding),
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
		"#include <stdlib.h>",
		...headers.map((header) => `#include "${header}"`),
		"",
		// Tentative definitions: helpers refer to these before their initializers.
		"static const MalFfiLibrary mal_ffi_library;",
		...[...plan.handles.keys()].map(
			(name) => `static const MalFfiHandleType mal_ffi_type_${name};`,
		),
		"",
		...writer.recordHelpers(),
		...writer.handleTypes(),
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
		direct: Object.fromEntries(
			plan.functions.map((binding) => {
				const result = directResult(binding);
				return [
					binding.name,
					{
						symbol: directSymbol(library, binding.name),
						arity: binding.params.length,
						...(result === undefined ? {} : { result }),
					},
				];
			}),
		),
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
