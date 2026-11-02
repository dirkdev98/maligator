import { ffiIntoSymbol } from "../build-config-values.ts";
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

function globalArrayStorage(binding: BoundFunction): string {
	return `mal_ffi_global_value_${binding.global!.declaration.name}`;
}

function countValue(
	binding: BoundFunction,
	index: number | undefined,
	context = "",
): string | undefined {
	if (index === undefined) return undefined;
	const entry = binding.arguments[index];
	if (entry?.kind === "result-count") return `${context}mal_count`;
	if (entry?.kind === "count" && entry.output !== undefined)
		return `${context}mal_output_${String(entry.output)}`;
	return `${context}mal_argument_${String(index)}`;
}

/** A binding's primitive normal result, which refines compiled caller facts. */
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
		case "bigint":
		case "undefined":
			return { kind: value.kind };
		default:
			return undefined;
	}
}

/** Values held directly in a MalValue, with no heap cell behind them. */
const IMMEDIATE_KINDS: ReadonlySet<JsValue["kind"]> = new Set([
	"boolean",
	"integer",
	"float",
]);

function immediateRecord(record: MappedRecord): boolean {
	return record.fields.every((field) => IMMEDIATE_KINDS.has(field.value.kind));
}

/**
 * Inputs whose conversion neither runs JavaScript nor allocates, and that nothing
 * reads after the C call, so a direct entry need not root them, unless the binding
 * can call back: then handles and buffers are pinned, and cleanup releases the pin
 * after the result's allocations.
 */
const UNROOTED_INPUTS: ReadonlySet<JsValue["kind"]> = new Set([
	"boolean",
	"integer",
	"float",
	"bigint",
	"string",
	"handle",
	"bytes",
]);

function inputCanRunJavaScript(value: JsValue): boolean {
	switch (value.kind) {
		case "undefined":
		case "boolean":
		case "integer":
		case "float":
		case "bigint":
		case "string":
		case "bytes":
		case "handle":
		case "callable":
			return false;
		case "callback":
		case "record":
		case "tagged":
		case "sequence":
		case "array":
			return true;
		case "union":
			return inputCanRunJavaScript(value.of);
	}
}

/** The struct a binding returns, when compiled callers can take its fields instead. */
function intoRecord(binding: BoundFunction): string | undefined {
	return binding.returns.kind === "record" && binding.outputs.length === 0
		? binding.returns.name
		: undefined;
}

/** The keys of the object a binding returns: a struct's fields, or its result and outputs. */
function intoFields(
	binding: BoundFunction,
	records: ReadonlyMap<string, MappedRecord>,
): ReadonlyArray<string> | undefined {
	if (binding.outputs.length > 0)
		return [
			...(binding.returns.kind === "undefined" ? [] : ["result"]),
			...binding.outputs.map((output) => output.name),
		];
	const record = intoRecord(binding);
	return record === undefined
		? undefined
		: records.get(record)!.fields.map((field) => field.name);
}

/** Whether compiled callers can take the object a binding returns into a stack object. */
function hasInto(binding: BoundFunction): boolean {
	return binding.outputs.length > 0 || intoRecord(binding) !== undefined;
}

function directEntry(
	library: string,
	binding: BoundFunction,
	pinsResources: boolean,
): Array<string> {
	return [
		...directEntryVariant(library, binding, pinsResources, false),
		...(hasInto(binding)
			? directEntryVariant(library, binding, pinsResources, true)
			: []),
	];
}

/**
 * The direct entry, or with `into` the entry that writes a struct result's fields into
 * a compiled caller's stack object and its slots.
 */
function directEntryVariant(
	library: string,
	binding: BoundFunction,
	pinsResources: boolean,
	into: boolean,
): Array<string> {
	const arity = binding.params.length;
	const symbol = into
		? ffiIntoSymbol(directSymbol(library, binding.name))
		: directSymbol(library, binding.name);
	const parameters = [
		...Array.from({ length: arity }, (_, index) => `, MalValue mal_a${String(index)}`),
		...(into ? [", void *mal_into, MalValue *mal_slots"] : []),
	];
	const extra = !hasInto(binding)
		? ""
		: into
			? ", mal_into, mal_slots"
			: ", nullptr, nullptr";
	// Compiled callers are not counted as native frames, so collection already runs
	// inside callbacks reached this way.
	const invoke = (args: string) =>
		`mal_ffi_call_${binding.name}(vm, ${args}, ${String(arity)}, false${extra})`;
	// Pinned handles are read again by cleanup, after the result's allocations.
	const rooted =
		arity > 0 &&
		(binding.closes !== undefined ||
			binding.params.some(({ value }) => !UNROOTED_INPUTS.has(value.kind)) ||
			(pinsResources &&
				binding.params.some(
					({ value }) => value.kind === "handle" || value.kind === "bytes",
				)));
	const args = arity === 0 ? "nullptr" : "mal_direct_args";
	return [
		"",
		`MalValue ${symbol}(MalVm *vm${parameters.join("")}) {`,
		...(arity === 0
			? []
			: [
					`	MalValue mal_direct_args[${String(arity)}] = { ${Array.from({ length: arity }, (_, index) => `mal_a${String(index)}`).join(", ")} };`,
				]),
		...(rooted
			? [
					"	MalFfiRoots mal_direct_roots;",
					`	mal_ffi_root(&mal_direct_roots, mal_direct_args, ${String(arity)});`,
					`	MalValue mal_direct_result = ${invoke(args)};`,
					"	mal_ffi_unroot(&mal_direct_roots);",
					"	return mal_direct_result;",
				]
			: [`	return ${invoke(args)};`]),
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
	readonly #unionInputs = new Set<string>();
	readonly #unionOutputs = new Set<string>();
	readonly #taggedInputs = new Set<string>();
	readonly #taggedOutputs = new Set<string>();
	readonly #managedFamilies = new Set<string>();
	readonly #viewFamilies = new Set<string>();
	readonly #viewFields = new Map<string, Array<{ handle: string; name: string }>>();
	readonly #workerCloseFamilies = new Set<string>();
	readonly #callables = new Map<string, Extract<JsValue, { kind: "callable" }>>();
	#counter = 0;

	constructor(model: CModel, plan: BindingPlan) {
		this.#model = model;
		this.#plan = plan;
		for (const handle of plan.handles.values()) {
			if (handle.managedFields.length > 0) this.#managedFamilies.add(handle.family);
			if (handle.views.length > 0) this.#viewFamilies.add(handle.family);
		}
		for (const handle of plan.handles.values()) {
			if (!this.#viewFamilies.has(handle.family)) continue;
			const fields = this.#viewFields.get(handle.family) ?? [];
			for (const field of handle.fields)
				if (field.value.kind === "callable")
					fields.push({ handle: handle.name, name: field.name });
			if (fields.length > 0) this.#viewFields.set(handle.family, fields);
		}
		for (const binding of plan.functions) {
			const value =
				binding.closes === undefined ? undefined : binding.params[binding.closes]?.value;
			if (binding.async !== undefined && value?.kind === "handle")
				this.#workerCloseFamilies.add(this.#handle(value.name).family);
		}
	}

	#resultGuards(binding: BoundFunction, fail: string): Array<string> {
		const handles = new Set<string>();
		const visit = (value: JsValue): void => {
			if (value.kind === "handle" && value.pass === "pointer" && value.fresh !== true) {
				if (this.#workerCloseFamilies.has(this.#handle(value.name).family))
					handles.add(value.name);
			} else if (value.kind === "sequence" || value.kind === "array") visit(value.of);
			else if (value.kind === "union") visit(value.of);
			else if (value.kind === "tagged")
				for (const entry of value.cases) visit(entry.value);
			else if (value.kind === "record")
				for (const field of this.#record(value.name).fields) visit(field.value);
		};
		visit(binding.returns);
		for (const output of binding.outputs) visit(output.value);
		return [...handles].map(
			(name) =>
				`if (!mal_ffi_handle_results_ready(vm, &mal_ffi_type_${name}, &mal_site_result)) ${fail}`,
		);
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

	managedFamily(name: string): boolean {
		return this.#managedFamilies.has(this.#handle(name).family);
	}

	#hasHandles(value: JsValue): boolean {
		if (value.kind === "tagged")
			return value.cases.some((entry) => this.#hasHandles(entry.value));
		if (value.kind === "union") return this.#hasHandles(value.of);
		if (value.kind === "handle") return true;
		if (value.kind === "record")
			return this.#record(value.name).fields.some((field) =>
				this.#hasHandles(field.value),
			);
		return (
			(value.kind === "array" || value.kind === "sequence") && this.#hasHandles(value.of)
		);
	}

	#compoundInputs(binding: BoundFunction): boolean {
		return binding.arguments.some((entry) => {
			if (entry.kind !== "input" && entry.kind !== "inout") return false;
			const value = binding.params[entry.param]!.value;
			return (
				(entry.kind === "inout" || value.kind !== "handle") && this.#hasHandles(value)
			);
		});
	}

	/** Mark the record helpers a value needs, recursively through fields and arrays. */
	need(value: JsValue, direction: "input" | "output"): void {
		if (value.kind === "callable") {
			if (this.#callables.has(value.name)) return;
			this.#callables.set(value.name, value);
			for (const param of value.signature.params) this.need(param.value, "input");
			for (const output of value.signature.outputs) this.need(output.value, "output");
			this.need(value.signature.returns, "output");
			return;
		}
		if (value.kind === "tagged") {
			const set = direction === "input" ? this.#taggedInputs : this.#taggedOutputs;
			if (set.has(value.name)) return;
			set.add(value.name);
			for (const entry of value.cases) this.need(entry.value, direction);
			return;
		}
		if (value.kind === "union") {
			const set = direction === "input" ? this.#unionInputs : this.#unionOutputs;
			if (set.has(value.name)) return;
			set.add(value.name);
			this.need(value.of, direction);
			return;
		}
		if (value.kind === "array" || value.kind === "sequence") {
			this.need(value.of, direction);
			return;
		}
		if (value.kind === "callback") {
			// A callback converts the other way: C arguments out, its result in.
			for (const param of value.params)
				if (param !== "data" && param !== "count") this.need(param, "output");
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
		/** Whether `source` is already rooted, as arguments and record fields are. */
		rooted: boolean,
		inputs = "nullptr",
		borrowString = false,
	): Array<string> {
		const cast = (expression: string) =>
			`(${localDeclaration(type, "")}) (${expression})`;
		switch (value.kind) {
			case "handle": {
				const temporary = this.#fresh("handle");
				return [
					`void *${temporary};`,
					`if (!${inputs === "nullptr" ? `mal_ffi_to_handle(vm, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${temporary}, nullptr)` : `mal_ffi_input_handle(vm, ${inputs}, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${temporary})`}) ${fail}`,
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
					`if (!mal_ffi_to_${width}(vm, ${source}, ${value.bits}, ${site}, &${temporary})) ${fail}`,
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
					`if (!mal_ffi_to_string(vm, ${source}, ${value.nullable}, ${value.counted === true ? "MAL_FFI_STRING_COUNTED" : "0"}${borrowString ? " | MAL_FFI_STRING_BORROW" : ""}, ${site}, &${temporary})) ${fail}`,
					`${target} = (${localDeclaration(type, "")}) ${temporary}.data;`,
				];
			}
			case "union":
			case "record": {
				const retained = this.#hasHandles(value) ? `, ${inputs}` : "";
				const helper =
					value.kind === "union"
						? `mal_ffi_union_in_${value.name}`
						: `mal_ffi_in_${value.name}`;
				if (rooted) {
					return [
						`if (!${helper}(vm, ${source}, ${site}, &${target}${retained})) ${fail}`,
					];
				}
				// A getter may return a fresh object that only this frame references.
				const held = this.#fresh("held");
				const roots = this.#fresh("roots");
				const converted = this.#fresh("converted");
				return [
					`MalValue ${held} = ${source};`,
					`MalFfiRoots ${roots};`,
					`mal_ffi_root(&${roots}, &${held}, 1);`,
					`bool ${converted} = ${helper}(vm, ${held}, ${site}, &${target}${retained});`,
					`mal_ffi_unroot(&${roots});`,
					`if (!${converted}) ${fail}`,
				];
			}
			case "tagged": {
				const retained = this.#hasHandles(value) ? `, ${inputs}` : "";
				if (rooted)
					return [
						`if (!mal_ffi_tagged_in_${value.name}(vm, ${source}, ${site}, &${target}${retained})) ${fail}`,
					];
				const held = this.#fresh("held"),
					roots = this.#fresh("roots"),
					converted = this.#fresh("converted");
				return [
					`MalValue ${held} = ${source};`,
					`MalFfiRoots ${roots};`,
					`mal_ffi_root(&${roots}, &${held}, 1);`,
					`bool ${converted} = mal_ffi_tagged_in_${value.name}(vm, ${held}, ${site}, &${target}${retained});`,
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
				const held = rooted ? source : this.#fresh("held");
				const roots = this.#fresh("roots");
				const failed = rooted ? fail : `{ mal_ffi_unroot(&${roots}); ${fail} }`;
				return [
					...(rooted
						? []
						: [
								`MalValue ${held} = ${source};`,
								`MalFfiRoots ${roots};`,
								`mal_ffi_root(&${roots}, &${held}, 1);`,
							]),
					`for (int32_t ${index} = 0; ${index} < ${value.length}; ${index}++) {`,
					`\tMalValue ${element};`,
					`\tif (!mal_ffi_element(vm, ${held}, ${index}, ${value.length}, ${site}, &${element})) ${failed}`,
					...this.read(
						value.of,
						resolved.of,
						element,
						`${target}[${index}]`,
						site,
						failed,
						strings,
						false,
						inputs,
					).map((line) => `\t${line}`),
					"}",
					...(rooted ? [] : [`mal_ffi_unroot(&${roots});`]),
				];
			}
			case "undefined":
				throw new Error("void has no input conversion");
			case "bytes":
			case "sequence":
				throw new Error("buffers and arrays convert with the count of their argument");
			case "callback":
				throw new Error("callbacks convert with their user data");
			case "callable":
				throw new Error("native callable values are results");
		}
	}

	/**
	 * An expression that converts the C value `expression` into a JavaScript value.
	 * A struct handle copies its struct, so `expression` must then be an lvalue.
	 */
	/** `lent`: a callback argument, whose handles close when the callback returns. */
	write(
		value: JsValue,
		expression: string,
		lent: boolean | string = false,
		owner = "mal_owner",
	): string {
		switch (value.kind) {
			case "callable":
				return `(${expression}) == nullptr ? mal_ffi_null() : mal_ffi_new_callable(vm, ${cString(value.site)}, ${value.signature.params.length}, mal_ffi_function_${value.name}, &(${expression}), sizeof(${expression}), ${value.owner === undefined ? "mal_ffi_undefined()" : owner})`;
			case "handle": {
				const created = (address: string) => {
					const loan = `mal_ffi_new_callback_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address})`;
					const ordinary = `mal_ffi_new_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address}, ${value.owned}, ${value.fresh === true})`;
					return typeof lent === "boolean"
						? lent
							? loan
							: ordinary
						: `(${lent}) ? ${loan} : ${ordinary}`;
				};
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
				if (value.counted) throw new Error("a counted string needs its byte length");
				return `mal_ffi_from_string(vm, ${expression})`;
			case "record":
				return `mal_ffi_out_${value.name}(vm, ${expression}, ${lent})`;
			case "union":
				return `mal_ffi_union_out_${value.name}(vm, ${expression}, ${lent})`;
			case "tagged":
				return `mal_ffi_tagged_out_${value.name}(vm, ${expression}, ${lent})`;
			case "array":
				throw new Error("arrays are written field by field");
		}
	}

	/**
	 * Statements that copy a C buffer or array of `count` elements into `target`, a
	 * rooted slot: a new Uint8Array or array, or null for a null pointer.
	 */
	#produceCounted(
		value: JsValue,
		expression: string,
		count: string,
		target: string,
	): Array<string> {
		const site = this.#fresh("site");
		const fill = [
			`static const MalFfiSite ${site} = { "callback", "length", nullptr };`,
			`if ((${expression}) == nullptr) ${target} = mal_ffi_null();`,
			`else if (!mal_ffi_check_count(vm, (size_t) (${count}), 32, true, &${site})) goto mal_done;`,
		];
		if (value.kind === "bytes") {
			return [
				...fill,
				`else ${target} = mal_ffi_from_bytes(vm, ${expression}, (size_t) (${count}));`,
				"if (mal_ffi_threw(vm)) goto mal_done;",
			];
		}
		if (value.kind === "string" && value.counted) {
			return [
				...fill,
				`else ${target} = mal_ffi_from_string_length(vm, (const char *) (${expression}), (size_t) (${count}));`,
				"if (mal_ffi_threw(vm)) goto mal_done;",
			];
		}
		if (value.kind !== "sequence") throw new Error("only buffers and arrays have counts");
		const index = this.#fresh("index");
		return [
			...fill,
			"else {",
			`\t${target} = mal_ffi_new_array(vm, (int32_t) (${count}));`,
			`\tfor (int32_t ${index} = 0; !mal_ffi_threw(vm) && ${index} < (int32_t) (${count}); ${index}++) {`,
			`\t\tmal_ffi_set_element(vm, ${target}, ${index}, ${this.write(value.of, `(${expression})[${index}]`, true)});`,
			"\t}",
			"}",
			"if (mal_ffi_threw(vm)) goto mal_done;",
		];
	}

	/** Statements that store the C value `expression` into the rooted container. */
	/**
	 * Statements that convert the C value `expression` into `target`, a rooted
	 * slot. Arrays fill a new array element by element.
	 */
	#produce(
		value: JsValue,
		expression: string,
		target: string,
		lent: boolean | string = false,
	): Array<string> {
		if (value.kind !== "array") {
			return [
				`${target} = ${this.write(value, expression, lent)};`,
				...(this.#allocates(value) ? ["if (mal_ffi_threw(vm)) goto mal_done;"] : []),
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
			...this.#produce(value.of, `${expression}[${index}]`, element, lent).map(
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
		if (value.kind === "union") return this.#allocates(value.of);
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

	/**
	 * The helpers that convert an input record: `mal_ffi_fields_<name>` converts field
	 * values already read, and `mal_ffi_in_<name>` reads them from an object first.
	 */
	/** Whether every field is an immediate value or a struct of such fields, at any depth. */
	#flat(record: MappedRecord): boolean {
		return record.fields.every(
			(field) =>
				IMMEDIATE_KINDS.has(field.value.kind) ||
				(field.value.kind === "record" && this.#flat(this.#record(field.value.name))),
		);
	}

	/** Whether `mal_ffi_record_leaves` can read the record in one call. */
	#readsLeaves(record: MappedRecord): boolean {
		return (
			record.fields.some((field) => field.value.kind === "record") && this.#flat(record)
		);
	}

	/** Input records read through `mal_ffi_record_leaves`, and the structs nested in them. */
	#leafRecords(): Set<string> {
		const names = new Set<string>();
		const add = (name: string): void => {
			if (names.has(name)) return;
			names.add(name);
			for (const field of this.#record(name).fields)
				if (field.value.kind === "record") add(field.value.name);
		};
		for (const name of this.#inputs) if (this.#readsLeaves(this.#record(name))) add(name);
		return names;
	}

	/**
	 * Convert a struct's immediate fields from `*mal_leaves`, depth first, advancing it.
	 * The record had its shape at every level, so field values are exactly what reading
	 * each level would produce, and conversion errors match.
	 */
	#recordLeaves(name: string): Array<string> {
		const record = this.#record(name);
		return [
			"",
			`static bool mal_ffi_leaves_${name}(MalVm *vm, const MalValue **mal_leaves, const MalFfiSite *mal_site, ${record.spelling} *mal_out) {`,
			"	MalFfiSite mal_field_site = *mal_site;",
			...record.fields.flatMap((field) => [
				`	mal_field_site.field = ${cString(field.name)};`,
				...(field.value.kind === "record"
					? [
							`	if (!mal_ffi_leaves_${field.value.name}(vm, mal_leaves, &mal_field_site, &mal_out->${field.name})) return false;`,
						]
					: [
							...this.read(
								field.value,
								field.type,
								"(*mal_leaves)[0]",
								`mal_out->${field.name}`,
								"&mal_field_site",
								"return false;",
								[],
								true,
							).map((line) => `	${line}`),
							"	(*mal_leaves)++;",
						]),
			]),
			"	return true;",
			"}",
		];
	}

	#recordInput(name: string): Array<string> {
		const record = this.#record(name);
		const retained = this.#hasHandles({ kind: "record", name });
		const parameter = retained ? ", MalFfiInputs *mal_inputs" : "";
		const count = String(record.fields.length);
		const lines = [
			"",
			`static bool mal_ffi_fields_${name}(MalVm *vm, const MalValue *mal_fields, const MalFfiSite *mal_site, ${record.spelling} *mal_out${parameter}) {`,
			"\tMalFfiSite mal_field_site = *mal_site;",
		];
		record.fields.forEach((field, index) => {
			lines.push(
				`\tmal_field_site.field = ${cString(field.name)};`,
				...this.read(
					field.value,
					field.type,
					`mal_fields[${String(index)}]`,
					`mal_out->${field.name}`,
					"&mal_field_site",
					"return false;",
					[],
					true,
					retained ? "mal_inputs" : "nullptr",
				).map((line) => `\t${line}`),
			);
		});
		// Immediate field values hold no heap reference a later getter's collection could free.
		const rootFields = !immediateRecord(record);
		lines.push(
			"\treturn true;",
			"}",
			"",
			`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${record.spelling} *mal_out${parameter}) {`,
			...(this.#readsLeaves(record)
				? [
						`\tMalValue mal_leaves[${String(this.#leafCount(record))}];`,
						`\tif (mal_ffi_record_leaves(vm, mal_value, &mal_ffi_record_${name}, mal_leaves)) {`,
						"\t\tconst MalValue *mal_leaf = mal_leaves;",
						`\t\treturn mal_ffi_leaves_${name}(vm, &mal_leaf, mal_site, mal_out);`,
						"\t}",
					]
				: []),
			`\tMalValue mal_fields[${count}] = {};`,
			...(rootFields
				? [
						"\tMalFfiRoots mal_roots;",
						`\tmal_ffi_root(&mal_roots, mal_fields, ${count});`,
					]
				: []),
			`\tbool mal_ok = mal_ffi_record_fields(vm, mal_value, &mal_ffi_record_${name}, mal_site, mal_fields) && mal_ffi_fields_${name}(vm, mal_fields, mal_site, mal_out${retained ? ", mal_inputs" : ""});`,
			...(rootFields ? ["\tmal_ffi_unroot(&mal_roots);"] : []),
			"\treturn mal_ok;",
			"}",
		);
		return lines;
	}

	#leafCount(record: MappedRecord): number {
		return record.fields.reduce(
			(total, field) =>
				total +
				(field.value.kind === "record"
					? this.#leafCount(this.#record(field.value.name))
					: 1),
			0,
		);
	}

	recordHelpers(): Array<string> {
		const lines: Array<string> = [];
		const inputs = [...this.#inputs].sort(byteOrder);
		const outputs = [...this.#outputs].sort(byteOrder);
		const leaves = [...this.#leafRecords()].sort(byteOrder);
		for (const name of inputs) {
			const record = this.#record(name);
			const retained = this.#hasHandles({ kind: "record", name })
				? ", MalFfiInputs *mal_inputs"
				: "";
			lines.push(
				`static bool mal_ffi_fields_${name}(MalVm *vm, const MalValue *mal_fields, const MalFfiSite *mal_site, ${record.spelling} *mal_out${retained});`,
				`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${record.spelling} *mal_out${retained});`,
			);
		}
		for (const name of leaves) {
			lines.push(
				`static bool mal_ffi_leaves_${name}(MalVm *vm, const MalValue **mal_leaves, const MalFfiSite *mal_site, ${this.#record(name).spelling} *mal_out);`,
			);
		}
		for (const name of outputs) {
			lines.push(
				`static MalValue mal_ffi_out_${name}(MalVm *vm, ${this.#record(name).spelling} mal_value, bool mal_lent);`,
			);
		}
		const typed = [...new Set([...inputs, ...outputs])].sort(byteOrder);
		for (const name of this.#unionInputs) {
			const union = this.#plan.unions.get(name)!;
			const retained = this.#hasHandles(union.member.value)
				? ", MalFfiInputs *mal_inputs"
				: "";
			lines.push(
				`static bool mal_ffi_union_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${union.spelling} *mal_out${retained});`,
			);
		}
		for (const name of this.#unionOutputs) {
			const union = this.#plan.unions.get(name)!;
			lines.push(
				`static MalValue mal_ffi_union_out_${name}(MalVm *vm, ${union.spelling} mal_value, bool mal_lent);`,
			);
		}
		lines.push(...this.#taggedHelpers(true));
		// Declared first, as nested-record tables point at types defined later.
		for (const name of typed)
			lines.push(`static MalFfiRecordType mal_ffi_record_${name};`);
		for (const name of typed) {
			const record = this.#record(name);
			const nested =
				leaves.includes(name) &&
				record.fields.some((field) => field.value.kind === "record");
			lines.push(
				`static const char *const mal_ffi_record_fields_${name}[] = { ${record.fields.map((field) => cString(field.name)).join(", ")} };`,
				...(nested
					? [
							`static MalFfiRecordType *const mal_ffi_record_nested_${name}[] = { ${record.fields.map((field) => (field.value.kind === "record" ? `&mal_ffi_record_${field.value.name}` : "nullptr")).join(", ")} };`,
						]
					: []),
				`static MalFfiRecordType mal_ffi_record_${name} = { mal_ffi_record_fields_${name}, ${String(record.fields.length)}, 0, ${nested ? `mal_ffi_record_nested_${name}` : "nullptr"} };`,
			);
		}
		for (const name of this.#unionInputs) {
			const union = this.#plan.unions.get(name)!;
			const retained = this.#hasHandles(union.member.value);
			lines.push(
				`static bool mal_ffi_union_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${union.spelling} *mal_out${retained ? ", MalFfiInputs *mal_inputs" : ""}) {`,
				...this.read(
					union.member.value,
					union.member.type,
					"mal_value",
					`mal_out->${union.member.name}`,
					"mal_site",
					"return false;",
					[],
					true,
					retained ? "mal_inputs" : "nullptr",
				),
				"return true;",
				"}",
			);
		}
		for (const name of this.#unionOutputs) {
			const union = this.#plan.unions.get(name)!;
			const rooted = this.#allocates(union.member.value);
			lines.push(
				`static MalValue mal_ffi_union_out_${name}(MalVm *vm, ${union.spelling} mal_value, bool mal_lent) {`,
				"MalValue mal_result = mal_ffi_undefined();",
				...(rooted
					? ["MalFfiRoots mal_roots;", "mal_ffi_root(&mal_roots, &mal_result, 1);"]
					: []),
				...this.#produce(
					union.member.value,
					`mal_value.${union.member.name}`,
					"mal_result",
					"mal_lent",
				),
				"mal_done:",
				...(rooted ? ["mal_ffi_unroot(&mal_roots);"] : []),
				"return mal_ffi_threw(vm) ? mal_ffi_undefined() : mal_result;",
				"}",
			);
		}
		lines.push(...this.#taggedHelpers(false));
		for (const name of leaves) lines.push(...this.#recordLeaves(name));
		for (const name of inputs) lines.push(...this.#recordInput(name));
		for (const name of outputs) {
			const record = this.#record(name);
			const count = record.fields.length;
			const rooted = record.fields.some((field) => this.#allocates(field.value));
			lines.push(
				"",
				// `mal_values` stays rooted by the caller while nested structs allocate.
				`static bool mal_ffi_fill_${name}(MalVm *vm, ${record.spelling} mal_value, MalValue *mal_values, bool mal_lent) {`,
			);
			record.fields.forEach((field, index) => {
				lines.push(
					...this.#produce(
						field.value,
						`mal_value.${field.name}`,
						`mal_values[${String(index)}]`,
						"mal_lent",
					).map((line) => `\t${line}`),
				);
			});
			lines.push(
				"\tgoto mal_done;",
				"mal_done:",
				"\treturn !mal_ffi_threw(vm);",
				"}",
				"",
				`static MalValue mal_ffi_out_${name}(MalVm *vm, ${record.spelling} mal_value, bool mal_lent) {`,
				`\tMalValue mal_values[${String(count)}] = {};`,
				"\tMalValue mal_record = mal_ffi_undefined();",
				...(rooted
					? [
							"\tMalFfiRoots mal_roots;",
							`\tmal_ffi_root(&mal_roots, mal_values, ${String(count)});`,
						]
					: []),
				`\tif (mal_ffi_fill_${name}(vm, mal_value, mal_values, mal_lent)) mal_record = mal_ffi_new_record(vm, &mal_ffi_record_${name}, mal_values);`,
				...(rooted ? ["\tmal_ffi_unroot(&mal_roots);"] : []),
				"\treturn mal_ffi_threw(vm) ? mal_ffi_undefined() : mal_record;",
				"}",
			);
		}
		return lines;
	}

	#taggedHelpers(declarations: boolean): Array<string> {
		const lines: Array<string> = [];
		for (const name of new Set([...this.#taggedInputs, ...this.#taggedOutputs])) {
			const tagged = this.#plan.tagged.get(name)!;
			const retained = tagged.cases.some((entry) =>
				this.#hasHandles({ kind: "record", name: entry.record.name }),
			);
			const input = `static bool mal_ffi_tagged_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${tagged.spelling} *mal_out${retained ? ", MalFfiInputs *mal_inputs" : ""})`;
			const output = `static MalValue mal_ffi_tagged_out_${name}(MalVm *vm, ${tagged.spelling} mal_value, bool mal_lent)`;
			if (declarations) {
				if (this.#taggedInputs.has(name)) lines.push(`${input};`);
				if (this.#taggedOutputs.has(name)) lines.push(`${output};`);
				continue;
			}
			if (this.#taggedInputs.has(name)) {
				lines.push(
					`static const char *const mal_ffi_tag_names_${name}[] = { ${cString(tagged.tag.name)} };`,
					`static MalFfiRecordType mal_ffi_tag_type_${name} = { mal_ffi_tag_names_${name}, 1, 0, nullptr };`,
					`${input} {`,
					"bool mal_ok = false;",
					"MalValue mal_tags[1] = {};",
					"MalFfiRoots mal_roots;",
					"mal_ffi_root(&mal_roots, mal_tags, 1);",
					`${localDeclaration(tagged.tag.type, "mal_tag")} = {};`,
					`if (!mal_ffi_record_fields(vm, mal_value, &mal_ffi_tag_type_${name}, mal_site, mal_tags)) goto mal_done;`,
					...this.read(
						tagged.tag.value,
						tagged.tag.type,
						"mal_tags[0]",
						"mal_tag",
						"mal_site",
						"goto mal_done;",
						[],
						true,
					),
					`*mal_out = (${tagged.spelling}) {};`,
					"switch (mal_tag) {",
				);
				for (const entry of tagged.cases) {
					const caseRetained = this.#hasHandles({
						kind: "record",
						name: entry.record.name,
					});
					lines.push(
						`case ${entry.expression}:`,
						`mal_out->${tagged.tag.name} = mal_tag;`,
						`if (!mal_ffi_in_${entry.record.name}(vm, mal_value, mal_site, mal_out${caseRetained ? ", mal_inputs" : ""})) goto mal_done;`,
						`if (mal_out->${tagged.tag.name} != mal_tag) { mal_ffi_expected(vm, mal_site, "a payload preserving its discriminator"); goto mal_done; }`,
						"mal_ok = true;",
						"break;",
					);
				}
				lines.push(
					'default: mal_ffi_expected(vm, mal_site, "a known union discriminator"); break;',
					"}",
					"mal_done:",
					"mal_ffi_unroot(&mal_roots);",
					"return mal_ok;",
					"}",
				);
			}
			if (this.#taggedOutputs.has(name)) {
				for (const [index, entry] of tagged.cases.entries()) {
					const fields = [tagged.tag, ...entry.record.fields];
					lines.push(
						`static const char *const mal_ffi_case_names_${name}_${index}[] = { ${fields.map((field) => cString(field.name)).join(", ")} };`,
						`static MalFfiRecordType mal_ffi_case_type_${name}_${index} = { mal_ffi_case_names_${name}_${index}, ${fields.length}, 0, nullptr };`,
					);
				}
				const count =
					Math.max(...tagged.cases.map((entry) => entry.record.fields.length)) + 1;
				lines.push(
					`${output} {`,
					`MalValue mal_fields[${count}] = {};`,
					"MalValue mal_result = mal_ffi_undefined();",
					"MalFfiRoots mal_roots;",
					`mal_ffi_root(&mal_roots, mal_fields, ${count});`,
					`switch (mal_value.${tagged.tag.name}) {`,
				);
				for (const [index, entry] of tagged.cases.entries()) {
					lines.push(`case ${entry.expression}:`);
					for (const [fieldIndex, field] of [
						tagged.tag,
						...entry.record.fields,
					].entries())
						lines.push(
							...this.#produce(
								field.value,
								`mal_value.${field.name}`,
								`mal_fields[${fieldIndex}]`,
								"mal_lent",
							),
						);
					lines.push(
						`mal_result = mal_ffi_new_record(vm, &mal_ffi_case_type_${name}_${index}, mal_fields);`,
						"goto mal_done;",
					);
				}
				lines.push(
					`default: { static const MalFfiSite mal_site = { "value", ${cString(tagged.tag.name)}, nullptr }; mal_ffi_expected(vm, &mal_site, "a known union discriminator"); break; }`,
					"}",
					"mal_done:",
					"mal_ffi_unroot(&mal_roots);",
					"return mal_ffi_threw(vm) ? mal_ffi_undefined() : mal_result;",
					"}",
				);
			}
		}
		return lines;
	}

	/** The descriptor of each handle type: its destroy wrapper and field accessors. */
	handleTypes(): Array<string> {
		const lines: Array<string> = [...this.#viewFields].map(
			([family, fields]) =>
				`static const MalFfiField mal_ffi_view_fields_${family}[${fields.length}];`,
		);
		for (const handle of this.#plan.handles.values()) {
			const name = handle.name;
			const shared = this.#viewFields.get(handle.family);
			const ownFields =
				shared === undefined
					? handle.fields
					: handle.fields.filter((field) => field.value.kind !== "callable");
			let destroy = "nullptr";
			if (handle.destroy !== undefined) {
				destroy = `mal_ffi_destroy_${name}`;
				const argument =
					handle.destroy.takes === "value"
						? `*(${handle.spelling} *) mal_value`
						: `(${handle.spelling} *) mal_value`;
				lines.push(
					"",
					`static bool ${destroy}(void *mal_value) {`,
					...(handle.destroy.success === undefined
						? [`\t${handle.destroy.name}(${argument});`, "\treturn true;"]
						: [
								`\treturn ${handle.destroy.name}(${argument}) == (${handle.destroy.success});`,
							]),
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
					`\tif (!mal_ffi_to_handle(vm, mal_this, &mal_ffi_type_${name}, false, &mal_site, &mal_handle, nullptr)) return mal_ffi_undefined();`,
					"\tif (!mal_ffi_handle_idle(vm, mal_this, &mal_site)) return mal_ffi_undefined();",
					`\t${handle.spelling} *mal_value = mal_handle;`,
					`\treturn ${this.write(field.value, `mal_value->${field.name}`, false, "mal_this")};`,
					"}",
				);
			}
			for (const [index, field] of handle.managedFields.entries()) {
				const prefix = `mal_ffi_managed_${name}_${field.name}`;
				lines.push(
					"",
					`static bool ${prefix}_read(void *mal_storage, void **mal_data, size_t *mal_length) {`,
					`\t${handle.spelling} *mal_state = mal_storage;`,
					...(field.signed ? [`\tif (mal_state->${field.count} < 0) return false;`] : []),
					`\tif ((uintmax_t) mal_state->${field.count} > SIZE_MAX) return false;`,
					`\t*mal_data = (void *) mal_state->${field.name};`,
					`\t*mal_length = (size_t) mal_state->${field.count};`,
					"\treturn true;",
					"}",
					"",
					`static void ${prefix}_write(void *mal_storage, void *mal_data, size_t mal_length) {`,
					`\t${handle.spelling} *mal_state = mal_storage;`,
					`\tmal_state->${field.name} = (${localDeclaration(field.type, "")}) mal_data;`,
					`\tmal_state->${field.count} = (${localDeclaration(field.countType, "")}) mal_length;`,
					"}",
					"",
					`static MalValue mal_ffi_get_${name}_${field.name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
					"\t(void) mal_args; (void) mal_argc; (void) mal_new_target; (void) mal_callee;",
					`\tstatic const MalFfiSite mal_site = { ${cString(`${name}.${field.name}`)}, "this", nullptr };`,
					`\treturn mal_ffi_state_value(vm, mal_this, &mal_ffi_type_${name}, ${index}, &mal_site);`,
					"}",
					"",
					`static MalValue mal_ffi_set_${name}_${field.name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
					"\t(void) mal_new_target; (void) mal_callee;",
					`\tstatic const MalFfiSite mal_site = { ${cString(`${name}.${field.name}`)}, "value", nullptr };`,
					`\tmal_ffi_set_state_value(vm, mal_this, &mal_ffi_type_${name}, ${index}, mal_argc > 0 ? mal_args[0] : mal_ffi_undefined(), &mal_site);`,
					"\treturn mal_ffi_undefined();",
					"}",
				);
			}
			const fieldCount = ownFields.length + handle.managedFields.length;
			const fields = fieldCount === 0 ? "nullptr" : `mal_ffi_fields_${name}`;
			if (fieldCount > 0) {
				lines.push(
					"",
					`static const MalFfiField ${fields}[] = {`,
					...ownFields.map(
						(field) =>
							`\t{ ${cString(field.name)}, mal_ffi_get_${name}_${field.name}, nullptr },`,
					),
					...handle.managedFields.map(
						(field) =>
							`\t{ ${cString(field.name)}, mal_ffi_get_${name}_${field.name}, mal_ffi_set_${name}_${field.name} },`,
					),
					"};",
				);
			}
			lines.push(
				"",
				...(handle.managedFields.length === 0
					? []
					: [
							`static const MalFfiManagedField mal_ffi_managed_fields_${name}[] = {`,
							...handle.managedFields.map(
								(field) =>
									`\t{ ${cString(field.name)}, mal_ffi_managed_${name}_${field.name}_read, mal_ffi_managed_${name}_${field.name}_write, ${field.bits}, ${field.signed}, ${field.writable}, ${field.kind === "string"} },`,
							),
							"};",
						]),
				...(handle.views.length === 0
					? []
					: [
							`static const MalFfiHandleType *const mal_ffi_views_${name}[] = {`,
							...handle.views.map((view) => `\t&mal_ffi_type_${view},`),
							"};",
						]),
				`static const MalFfiHandleType mal_ffi_type_${name} = {`,
				`\t${cString(name)},`,
				`\t${handle.representation === "struct" ? `sizeof(${handle.spelling})` : "0"},`,
				`\t${handle.representation === "struct" ? `_Alignof(${handle.spelling})` : "0"},`,
				`\t${destroy},`,
				`\t${handle.destroy === undefined ? "nullptr" : cString(handle.destroy.name)},`,
				`\t${handle.destroy?.success !== undefined},`,
				`\t${handle.collect},`,
				`\t${fields},`,
				`\t${String(fieldCount)},`,
				`\t${this.#viewFamilies.has(handle.family) ? `&mal_ffi_type_${handle.family}` : "nullptr"},`,
				`\t${handle.views.length === 0 ? "nullptr" : `mal_ffi_views_${name}`},`,
				`\t${String(handle.views.length)},`,
				`\t${handle.managedFields.length === 0 ? "nullptr" : `mal_ffi_managed_fields_${name}`},`,
				`\t${handle.managedFields.length},`,
				`\t${shared === undefined ? "nullptr" : `mal_ffi_view_fields_${handle.family}`},`,
				`\t${shared?.length ?? 0},`,
				"};",
			);
			if (handle.allocator !== undefined)
				lines.push(
					"",
					`static MalValue mal_ffi_allocate_${handle.allocator}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
					"\t(void) mal_this;",
					"\t(void) mal_args;",
					"\t(void) mal_argc;",
					"\t(void) mal_new_target;",
					"\t(void) mal_callee;",
					`\treturn mal_ffi_allocate_handle(vm, &mal_ffi_library, &mal_ffi_type_${name}, sizeof(${handle.spelling}), _Alignof(${handle.spelling}));`,
					"}",
				);
		}
		for (const [family, fields] of this.#viewFields)
			lines.push(
				`static const MalFfiField mal_ffi_view_fields_${family}[] = {`,
				...fields.map(
					(field) =>
						`\t{ ${cString(field.name)}, mal_ffi_get_${field.handle}_${field.name}, nullptr },`,
				),
				"};",
			);
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
		// A result that allocates nothing is simply ignored when a throw is pending.
		const unlessThrew =
			pending && this.#allocates(value) ? "if (!mal_ffi_threw(vm)) " : "";
		const handle =
			value.kind === "handle" && value.owned ? this.#handle(value.name) : undefined;
		if (pending && handle?.destroy !== undefined) {
			// A callback threw, so no handle will own the new resource: release it here.
			const pointer =
				handle.representation === "struct"
					? `&(${expression})`
					: `(void *) (${expression})`;
			const present =
				handle.representation === "pointer" ? `(${expression}) != nullptr` : "true";
			return [
				`if (!mal_ffi_threw(vm)) ${target} = ${this.write(value, expression)};`,
				`else if (${present}) mal_ffi_destroy_${handle.name}(${pointer});`,
				...release,
			];
		}
		if (value.kind === "bytes") {
			return [
				`${unlessThrew}${target} = (${expression}) == nullptr ? mal_ffi_null() : mal_ffi_from_bytes(vm, ${expression}, (size_t) (${count}));`,
				...release,
			];
		}
		if (value.kind === "string" && value.counted) {
			return [
				`${unlessThrew}${target} = mal_ffi_from_string_length(vm, (const char *) (${expression}), (size_t) (${count}));`,
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
	 * JavaScript function its user data names, or else the one `site` keeps, and
	 * converts the result back. After an exception, later calls return zero without
	 * running JavaScript.
	 */
	#trampoline(
		name: string,
		value: Extract<JsValue, { kind: "callback" }>,
		owner: string,
		site?: string,
		lane = 0,
	): Array<string> {
		const type = value.type;
		const params = type.params.map((param, index) =>
			formatCDeclaration(param, `mal_c${String(index)}`),
		);
		const data = value.params.indexOf("data");
		const inputs = value.params.flatMap((param, index) =>
			param === "data" || param === "count" ? [] : [{ value: param, index }],
		);
		const returns = value.returns.kind !== "undefined";
		const count = String(inputs.length);
		// Handles the library lends belong to this invocation and close when it returns.
		const lends = inputs.some(
			({ value: input, index }) =>
				index !== value.closes?.keyParam && this.#hasHandles(input),
		);
		const keyParam = value.closes?.keyParam ?? value.replaced?.keyParam;
		const lookup = value.lookup;
		// Without user data, a call-scoped callback is the one its call published.
		const scoped =
			data < 0 &&
			lookup === undefined &&
			value.replaced === undefined &&
			value.closes === undefined;
		const routed =
			data >= 0
				? `mal_c${String(data)}`
				: lookup !== undefined
					? `(MalFfiCallback *) ${lookup.function}(mal_c${String(lookup.param)})`
					: scoped
						? site!
						: `mal_ffi_replaced(&${site!}, ${keyParam === undefined ? "nullptr" : `(void *) mal_c${String(keyParam)}`}, ${String(lane)})`;
		const callback =
			value.closes === undefined
				? routed
				: `mal_ffi_close_take(&${site!}, ${keyParam === undefined ? "nullptr" : `(void *) mal_c${String(keyParam)}`}, ${data >= 0 || lookup !== undefined ? `(MalFfiCallback *) ${routed}` : "nullptr"})`;
		// A queued callback's body runs as `_run` with the callback its entry found, for
		// calls on the VM thread and queued ones, which must not look it up again.
		const queued = value.queued !== undefined;
		const keyedLookup = value.replaced !== undefined && data < 0 && lookup === undefined;
		const body = queued ? `${name}_run` : name;
		const signature = [...(queued ? ["MalFfiCallback *mal_callback"] : []), ...params];
		const resultLocals: Array<string> = [];
		const resultConversion: Array<string> = [];
		const resultCleanup: Array<string> = [];
		if (value.returnLifetime !== undefined && value.returns.kind === "handle") {
			const result = value.returns;
			resultLocals.push("void *mal_result_handle = nullptr;");
			resultConversion.push(
				`if (!mal_ffi_callback_result_handle(vm, mal_callback, mal_result, &mal_ffi_type_${result.name}, ${result.nullable}, ${value.returnLifetime === "registration"}, &mal_site, &mal_result_handle)) goto mal_done;`,
				`mal_return = (${localDeclaration(type.returns, "")}) mal_result_handle;`,
			);
		} else if (value.returnLifetime !== undefined) {
			const result = value.returns;
			if (result.kind !== "string" && result.kind !== "bytes")
				throw new Error("pointer result without a byte representation");
			resultLocals.push(
				"void *mal_result_data = nullptr;",
				"size_t mal_result_length = 0;",
			);
			if (result.kind === "string") {
				resultLocals.push("MalFfiString mal_result_text = {.data = nullptr};");
				resultConversion.push(
					`if (!mal_ffi_to_string(vm, mal_result, ${result.nullable}, ${result.counted === true ? "MAL_FFI_STRING_COUNTED" : "0"}, &mal_site, &mal_result_text)) goto mal_done;`,
					"mal_result_data = mal_result_text.data;",
					"mal_result_length = mal_result_text.length;",
				);
				resultCleanup.push("mal_ffi_string_release(&mal_result_text);");
			} else
				resultConversion.push(
					`if (!mal_ffi_to_bytes(vm, mal_result, ${result.nullable}, false, &mal_site, &mal_result_data, &mal_result_length, nullptr)) goto mal_done;`,
				);
			if (value.resultCount !== undefined)
				resultConversion.push(
					`if (!mal_ffi_check_count(vm, mal_result_length, ${value.resultCount.bits}, ${value.resultCount.signed}, &mal_site)) goto mal_done;`,
				);
			resultConversion.push(
				`mal_return = mal_result == mal_ffi_null() ? nullptr : (${localDeclaration(type.returns, "")}) mal_ffi_callback_result_copy(vm, mal_callback, mal_result_data, mal_result_length, ${result.kind === "string"}, ${value.returnLifetime === "registration"});`,
			);
			if (value.resultCount !== undefined) {
				const countType = resolveCType(
					this.#model,
					type.params[value.resultCount.param]!,
				);
				if (countType.kind !== "pointer")
					throw new Error("callback result count without a pointer");
				resultConversion.push(
					`if (!mal_ffi_threw(vm)) *mal_c${String(value.resultCount.param)} = (${localDeclaration(countType.to, "")}) mal_result_length;`,
				);
			}
		} else if (returns)
			resultConversion.push(
				...this.read(
					value.returns,
					type.returns,
					"mal_result",
					"mal_return",
					"&mal_site",
					"goto mal_done;",
					[],
					false,
				),
			);
		const lines = [
			"",
			`static ${formatCDeclaration(type.returns, `${body}(${signature.length === 0 ? "void" : signature.join(", ")})`)} {`,
			...(queued ? [] : [`\tMalFfiCallback *mal_callback = ${callback};`]),
			...(returns ? [`\t${localDeclaration(type.returns, "mal_return")} = {};`] : []),
			...(value.resultCount === undefined
				? []
				: [
						`\tif (mal_c${String(value.resultCount.param)} != nullptr) *mal_c${String(value.resultCount.param)} = 0;`,
					]),
			...(scoped
				? ["\tif (mal_callback == nullptr) mal_ffi_callback_lost();"]
				: data < 0 || value.closes !== undefined
					? [`\tif (mal_callback == nullptr) return${returns ? " mal_return" : ""};`]
					: []),
			...(value.kept
				? [
						...(keyedLookup && !queued ? [] : ["\tmal_ffi_callback_hold(mal_callback);"]),
						"\tMalVm *vm = mal_ffi_callback_vm(mal_callback);",
						// A library may call back after the VM is gone; it gets a zero result.
						`\tif (vm == nullptr) { mal_ffi_callback_drop(mal_callback); return${returns ? " mal_return" : ""}; }`,
					]
				: [
						"\tMalVm *vm = mal_ffi_callback_vm(mal_callback);",
						`\tif (vm == nullptr) return${returns ? " mal_return" : ""};`,
					]),
			`\tstatic const MalFfiSite mal_site = { ${cString(owner)}, "callback result", nullptr };`,
			"\t(void) mal_site;",
			`\tMalValue mal_values[${inputs.length === 0 ? "1" : count}] = {};`,
			"\tMalValue mal_result = mal_ffi_undefined();",
			"\tMalFfiRoots mal_roots;",
			`\tmal_ffi_root(&mal_roots, mal_values, ${count});`,
			"\tMalFfiRoots mal_result_roots;",
			"\tmal_ffi_root(&mal_result_roots, &mal_result, 1);",
			...(lends ? ["\tbool mal_lent = false;"] : []),
			...resultLocals.map((line) => `\t${line}`),
			...(value.resultCount === undefined
				? []
				: [
						`\tif (mal_c${String(value.resultCount.param)} == nullptr) {`,
						'\t\tmal_ffi_expected(vm, &mal_site, "a writable callback result count");',
						"\t\tgoto mal_done;",
						"\t}",
					]),
			...(value.closes === undefined
				? []
				: [
						...inputs.flatMap((input, position) =>
							input.index === value.closes!.keyParam
								? [
										`\tmal_values[${String(position)}] = mal_ffi_close_value(mal_callback);`,
									]
								: [],
						),
						"\tmal_ffi_close_finish(mal_callback);",
					]),
			"\tif (mal_ffi_threw(vm)) goto mal_done;",
			...(lends
				? ["\tif (!(mal_lent = mal_ffi_callback_enter(vm))) goto mal_done;"]
				: []),
			...inputs.flatMap((input, position) => {
				if (value.closes !== undefined && input.index === value.closes.keyParam)
					return [];
				const counted = value.counts[input.index];
				return (
					counted === undefined
						? this.#produce(
								input.value,
								`mal_c${String(input.index)}`,
								`mal_values[${String(position)}]`,
								true,
							)
						: this.#produceCounted(
								input.value,
								`mal_c${String(input.index)}`,
								`mal_c${String(counted)}`,
								`mal_values[${String(position)}]`,
							)
				).map((line) => `\t${line}`);
			}),
			`\tif (!mal_ffi_call(vm, mal_callback->function, mal_values, ${count}, &mal_result)) goto mal_done;`,
			...(returns
				? resultConversion.map((line) => `\t${line}`)
				: ["\t(void) mal_result;"]),
			"mal_done:",
			...resultCleanup.map((line) => `\t${line}`),
			...(returns
				? [
						`\tif (mal_ffi_threw(vm)) mal_return = (${localDeclaration(type.returns, "")}) {};`,
						...(value.resultCount === undefined
							? []
							: [
									`\tif (mal_ffi_threw(vm) && mal_c${String(value.resultCount.param)} != nullptr) *mal_c${String(value.resultCount.param)} = 0;`,
								]),
					]
				: []),
			...(lends ? ["\tif (mal_lent) mal_ffi_callback_leave(vm);"] : []),
			"\tmal_ffi_unroot(&mal_result_roots);",
			"\tmal_ffi_unroot(&mal_roots);",
			...(value.kept ? ["\tmal_ffi_callback_drop(mal_callback);"] : []),
			returns ? "\treturn mal_return;" : "\treturn;",
			"}",
		];
		return queued ? [...lines, ...this.#queuedEntry(name, value, callback)] : lines;
	}

	/**
	 * Waiting callers keep pointed-to arguments alive until VM conversion finishes.
	 * Notification callers continue at once, so their messages own argument copies.
	 */
	#queuedEntry(
		name: string,
		value: Extract<JsValue, { kind: "callback" }>,
		callback: string,
	): Array<string> {
		const type = value.type;
		const message = `MalFfiQueued_${name}`;
		const returns = value.returns.kind !== "undefined";
		const waiting = value.queued === "wait";
		const keyedLookup =
			value.replaced !== undefined &&
			!value.params.includes("data") &&
			value.lookup === undefined;
		const args = type.params.map((_, index) => `mal_c${String(index)}`);
		const owned = (index: number): boolean => {
			const param = value.params[index];
			return (
				!waiting &&
				typeof param === "object" &&
				(param.kind === "string" || param.kind === "bytes")
			);
		};
		const checkedCopies =
			!waiting &&
			value.params.some(
				(param) =>
					typeof param === "object" &&
					(param.kind === "bytes" || (param.kind === "string" && param.counted)),
			);
		const copies = type.params.flatMap((_, index) => {
			const param = value.params[index];
			const field = `mal_message->mal_c${String(index)}`;
			const source = `mal_c${String(index)}`;
			if (
				waiting ||
				typeof param !== "object" ||
				(param.kind !== "string" && param.kind !== "bytes")
			) {
				return [`${field} = ${source};`];
			}
			if (param.kind === "bytes" || param.counted) {
				const copy = `mal_copy_${String(index)}`;
				const status = `mal_copy_status_${String(index)}`;
				return [
					`void *${copy};`,
					`MalFfiCopyStatus ${status} = mal_ffi_copy_callback_bytes(${source}, (uint64_t) mal_c${String(value.counts[index]!)}, ${param.kind === "string"}, &${copy});`,
					`${field} = ${copy};`,
					`if (mal_message->mal_copy_error == MAL_FFI_COPY_OK) mal_message->mal_copy_error = ${status};`,
				];
			}
			const size = `__builtin_strlen((const char *) ${source}) + 1`;
			const copy = `mal_copy_${String(index)}`;
			// A zero-length buffer still gets a pointer, so it converts as empty, not null.
			return [
				`${field} = nullptr;`,
				`if (${source} != nullptr) {`,
				`\tsize_t mal_size_${String(index)} = ${size};`,
				`\tvoid *${copy} = malloc(mal_size_${String(index)} == 0 ? 1 : mal_size_${String(index)});`,
				`\tif (${copy} == nullptr) mal_ok = false;`,
				`\telse __builtin_memcpy(${copy}, ${source}, mal_size_${String(index)});`,
				`\t${field} = ${copy};`,
				"}",
			];
		});
		const params = type.params.map((param, index) =>
			formatCDeclaration(param, `mal_c${String(index)}`),
		);
		return [
			"",
			`typedef struct ${message} {`,
			...(checkedCopies ? ["\tMalFfiCopyStatus mal_copy_error;"] : []),
			...(returns ? [`\t${localDeclaration(type.returns, "mal_return")};`] : []),
			// Locals' declarations drop a top-level `const`, which the copies assign.
			...type.params.map(
				(param, index) => `\t${localDeclaration(param, `mal_c${String(index)}`)};`,
			),
			...(type.params.length === 0 ? ["\tchar mal_unused;"] : []),
			`} ${message};`,
			"",
			`static void ${name}_free(void *mal_data) {`,
			`\t${message} *mal_message = mal_data;`,
			...type.params.flatMap((_, index) =>
				owned(index) ? [`\tfree((void *) mal_message->mal_c${String(index)});`] : [],
			),
			"\tfree(mal_message);",
			"}",
			"",
			`static void ${name}_queued(MalVm *vm, MalFfiCallback *mal_callback, void *mal_data) {`,
			"\t(void) vm;",
			`\t${message} *mal_message = mal_data;`,
			"\t(void) mal_message;",
			...(checkedCopies
				? [
						"\tif (mal_message->mal_copy_error != MAL_FFI_COPY_OK) {",
						"\t\tmal_ffi_callback_copy_error(vm, mal_message->mal_copy_error);",
						"\t\treturn;",
						"\t}",
					]
				: []),
			`\t${returns ? "mal_message->mal_return = " : ""}${name}_run(${["mal_callback", ...args.map((arg) => `mal_message->${arg}`)].join(", ")});`,
			"}",
			"",
			`static ${formatCDeclaration(type.returns, `${name}(${params.length === 0 ? "void" : params.join(", ")})`)} {`,
			...(returns ? [`\t${localDeclaration(type.returns, "mal_return")} = {};`] : []),
			...(value.resultCount === undefined
				? []
				: [
						`\tif (mal_c${String(value.resultCount.param)} != nullptr) *mal_c${String(value.resultCount.param)} = 0;`,
					]),
			...(waiting ? ["\tint mal_cancellation = mal_ffi_callback_wait_enter();"] : []),
			`\tMalFfiCallback *mal_callback = ${callback};`,
			"\tif (mal_callback != nullptr && !mal_ffi_callback_here(mal_callback)) {",
			// A lookup without user data already reserved the call under its lock.
			...(!keyedLookup ? ["\t\tmal_ffi_callback_reserve(mal_callback);"] : []),
			`\t\t${message} *mal_message = malloc(sizeof(*mal_message));`,
			"\t\tif (mal_message != nullptr) {",
			"\t\t\tbool mal_ok = true;",
			...(checkedCopies ? ["\t\t\tmal_message->mal_copy_error = MAL_FFI_COPY_OK;"] : []),
			...copies.map((line) => `\t\t\t${line}`),
			"\t\t\tif (!mal_ok) {",
			`\t\t\t\t${name}_free(mal_message);`,
			"\t\t\t\tmal_message = nullptr;",
			"\t\t\t}",
			"\t\t}",
			waiting
				? `\t\tmal_ffi_callback_wait(mal_callback, ${name}_queued, mal_message, ${name}_free, ${returns ? `&mal_return, offsetof(${message}, mal_return), sizeof(mal_return)` : "nullptr, 0, 0"});`
				: `\t\tmal_ffi_callback_queue(mal_callback, ${name}_queued, mal_message, ${name}_free);`,
			...(value.closes === undefined ? [] : ["\t\tmal_ffi_close_return(mal_callback);"]),
			...(keyedLookup ? ["\t\tmal_ffi_callback_drop(mal_callback);"] : []),
			...(waiting ? ["\t\tmal_ffi_callback_wait_leave(mal_cancellation);"] : []),
			`\t\treturn${returns ? " mal_return" : ""};`,
			"\t}",
			`\t${returns ? "mal_return = " : ""}${name}_run(${["mal_callback", ...args].join(", ")});`,
			...(value.closes === undefined ? [] : ["\tmal_ffi_close_return(mal_callback);"]),
			...(keyedLookup
				? ["\tif (mal_callback != nullptr) mal_ffi_callback_drop(mal_callback);"]
				: []),
			...(waiting ? ["\tmal_ffi_callback_wait_leave(mal_cancellation);"] : []),
			...(returns ? ["\treturn mal_return;"] : []),
			"}",
		];
	}

	callableDeclarations(): Array<string> {
		return [...this.#callables.values()].flatMap((value) => [
			`typedef ${value.targetType} MalFfiTarget_${value.name};`,
			`static MalValue mal_ffi_function_${value.name}(MalVm *, MalValue, const MalValue *, int32_t, MalValue, MalValue);`,
		]);
	}

	callableHelpers(): Array<string> {
		return [...this.#callables.values()].flatMap((value) =>
			this.function(value.signature, value),
		);
	}

	function(
		binding: BoundFunction,
		callable?: Extract<JsValue, { kind: "callable" }>,
	): Array<string> {
		const name = binding.name;
		const siteName = callable?.site ?? name;
		const owner = callable?.owner;
		const declaration = binding.declaration;
		const locals: Array<string> = [];
		const body: Array<string> = [];
		/** Buffers resolve last: nothing may run JavaScript between them and the call. */
		const buffers: Array<string> = [];
		/** Kept callbacks, then the arguments that route to them, after the buffers. */
		const keeps: Array<string> = [];
		const kept: Array<string> = [];
		const commits: Array<string> = [];
		const callbackStarts: Array<string> = [];
		const callbackReturns: Array<string> = [];
		const replacedIndexes = new Set<number>();
		const keptCallback = (index: number): boolean => {
			const entry = binding.arguments[index];
			const value =
				entry?.kind === "input" ? binding.params[entry.param]?.value : undefined;
			return value?.kind === "callback" && value.kept;
		};
		const cleanup: Array<string> = [];
		const strings: Array<string> = [];
		const trampolines: Array<string> = [];
		const compoundInputs = this.#compoundInputs(binding);
		const inputs = compoundInputs ? "&mal_inputs" : "nullptr";
		if (compoundInputs) locals.push("MalFfiInputs mal_inputs;");
		/** Whether JavaScript can run between converting an argument and the C call returning. */
		const runsJavaScript =
			this.#plan.hasCallbacks ||
			binding.params.some(({ value }) => inputCanRunJavaScript(value));
		/** Whether JavaScript can run during the C call itself, in a callback. */
		const callsBack =
			this.#plan.hasCallbacks ||
			binding.params.some((param) => param.value.kind === "callback");
		const borrowString = (type: CType): boolean => {
			const pointer = resolveCType(this.#model, type);
			if (pointer.kind !== "pointer") return false;
			const target = resolveCType(this.#model, pointer.to);
			return (
				!runsJavaScript &&
				!callsBack &&
				binding.outputs.length === 0 &&
				["undefined", "integer", "float", "boolean"].includes(binding.returns.kind) &&
				"const" in target &&
				target.const === true
			);
		};
		const argument = (param: number) =>
			`mal_argc > ${String(param)} ? mal_args[${String(param)}] : mal_ffi_undefined()`;
		binding.params.forEach((param, index) => {
			locals.push(
				`static const MalFfiSite mal_site_${String(index)} = { ${cString(siteName)}, ${cString(param.name)}, nullptr };`,
			);
		});
		locals.push(
			`static const MalFfiSite mal_site_result = { ${cString(siteName)}, "result", nullptr };`,
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
			const entry = binding.arguments[target.index];
			const output = entry?.kind === "count" ? entry.output : undefined;
			// A count the function updates lives in an output local it gets the address of.
			const type = output === undefined ? target.type : binding.outputs[output]!.type;
			const integer = resolveCType(this.#model, type);
			const bits =
				integer.kind === "integer"
					? (this.#model.target.sizes[integer.name] ?? 4) * 8
					: 32;
			const signed =
				integer.kind === "integer" &&
				(integer.name === "char"
					? this.#model.target.charSigned
					: !integer.name.startsWith("unsigned"));
			into.push(
				`if (!mal_ffi_check_count(vm, (size_t) (${count}), ${bits}, ${signed}, ${site})) goto mal_done;`,
				...(output === undefined
					? [
							`mal_argument_${String(target.index)} = (${localDeclaration(type, "")}) (${count});`,
						]
					: [
							`mal_output_${String(output)} = (${localDeclaration(type, "")}) (${count});`,
							`mal_argument_${String(target.index)} = &mal_output_${String(output)};`,
						]),
			);
		};
		binding.arguments.forEach((entry, index) => {
			const param = declaration.params[index]!;
			const local = `mal_argument_${String(index)}`;
			const resolved = resolveCType(this.#model, param.type);
			if (binding.global?.access === "set" && resolved.kind === "array") {
				const storage = globalArrayStorage(binding);
				locals.push(`__typeof__((${storage}){0} + 0) ${local} = nullptr;`);
				body.push(
					`${local} = malloc(sizeof(${storage}));`,
					`if (${local} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
				);
				cleanup.push(`free(${local});`);
			} else locals.push(`${localDeclaration(param.type, local)};`);
			const pointee = resolved.kind === "pointer" ? resolved.to : param.type;
			switch (entry.kind) {
				case "count":
					if (entry.output !== undefined) {
						locals.push(
							`${localDeclaration(pointee, `mal_output_${String(entry.output)}`)} = {};`,
						);
						body.push(`${local} = &mal_output_${String(entry.output)};`);
					}
					return;
				case "result-count":
					locals.push(`${localDeclaration(pointee, "mal_count")} = {};`);
					body.push(`${local} = &mal_count;`);
					return;
				case "constant":
					if (entry.sizeLimit !== undefined)
						locals.push(
							`static_assert(${entry.expression} <= UINT64_C(${entry.sizeLimit}), "C type size exceeds parameter range");`,
						);
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
						const value = binding.params[entry.param]!.value;
						if (value.kind === "string" && value.counted) {
							const text = this.#fresh("string");
							const site = `&mal_site_${String(entry.param)}`;
							strings.push(text);
							body.push(
								`if (!mal_ffi_to_string(vm, ${argument(entry.param)}, ${value.nullable}, MAL_FFI_STRING_COUNTED, ${site}, &${text})) goto mal_done;`,
								`${output} = (${localDeclaration(pointee, "")}) ${text}.data;`,
							);
							setCount(index, `${text}.length`, site, body);
						} else
							body.push(
								...this.read(
									binding.params[entry.param]!.value,
									pointee,
									argument(entry.param),
									output,
									`&mal_site_${String(entry.param)}`,
									"goto mal_done;",
									strings,
									true,
									inputs,
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
					if (value.kind === "string" && value.counted) {
						const text = this.#fresh("string");
						strings.push(text);
						body.push(
							`if (!mal_ffi_to_string(vm, ${source}, ${value.nullable}, MAL_FFI_STRING_COUNTED${borrowString(param.type) ? " | MAL_FFI_STRING_BORROW" : ""}, ${site}, &${text})) goto mal_done;`,
							`${local} = (${localDeclaration(param.type, "")}) ${text}.data;`,
						);
						setCount(index, `${text}.length`, site, body);
						return;
					}
					if (value.kind === "bytes") {
						locals.push(
							`void *mal_bytes_${String(index)};`,
							`size_t mal_bytes_length_${String(index)};`,
						);
						// Buffers convert after every getter, so only a callback could detach one.
						const pin = callsBack ? `&mal_pin_${String(index)}` : "nullptr";
						if (callsBack) {
							locals.push(`void *mal_pin_${String(index)} = nullptr;`);
							cleanup.push(`mal_ffi_unpin(mal_pin_${String(index)});`);
						}
						buffers.push(
							`if (!mal_ffi_to_bytes(vm, ${source}, ${value.nullable}, ${value.writable === true}, ${site}, &mal_bytes_${String(index)}, &mal_bytes_length_${String(index)}, ${pin})) goto mal_done;`,
							`${local} = (${localDeclaration(param.type, "")}) mal_bytes_${String(index)};`,
						);
						setCount(index, `mal_bytes_length_${String(index)}`, site, buffers);
						return;
					}
					if (value.kind === "callback" && value.kept) {
						const trampoline =
							value.replaced === undefined
								? `mal_ffi_callback_${name}_${String(index)}`
								: `mal_ffi_replacement_callback_${String(name.length)}_${name}_${String(index)}`;
						const context = `mal_kept_${String(index)}`;
						const replaced = `mal_ffi_replaced_${name}_${String(index)}`;
						const transaction = `mal_replacement_${String(index)}`;
						const lanes =
							value.replaced !== undefined &&
							!value.params.includes("data") &&
							value.lookup === undefined;
						if (value.replaced !== undefined)
							trampolines.push("", `static MalFfiReplaced ${replaced};`);
						else if (value.closes !== undefined)
							trampolines.push("", `static char ${replaced};`);
						if (lanes) {
							for (const lane of [0, 1])
								trampolines.push(
									...this.#trampoline(
										`${trampoline}_${String(lane)}`,
										value,
										name,
										replaced,
										lane,
									),
								);
						} else
							trampolines.push(...this.#trampoline(trampoline, value, name, replaced));
						locals.push(`MalFfiCallback *${context} = nullptr;`);
						body.push(
							`if (!mal_ffi_to_function(vm, ${source}, ${value.nullable}, ${site})) goto mal_done;`,
						);
						// Kept last, after every conversion that can fail, so a failed call
						// never leaves a function rooted that no library holds.
						keeps.push(
							`if ((${source}) != mal_ffi_null()) {`,
							`\t${context} = ${value.queued !== undefined ? "mal_ffi_keep_queued" : "mal_ffi_keep"}(vm, ${source});`,
							`\tif (${context} == nullptr) goto mal_done;`,
							"}",
						);
						kept.push(
							`${local} = ${context} == nullptr ? nullptr : ${lanes ? `(${transaction}.lane == 0 ? ${trampoline}_0 : ${trampoline}_1)` : trampoline};`,
						);
						if (value.closes !== undefined) {
							keeps.push(
								`if (!mal_ffi_close_prepare(vm, ${context}, ${argument(value.closes.param)}, &${replaced}, ${site})) goto mal_done;`,
							);
							commits.push(
								`mal_ffi_close_commit(${context}, &mal_handle_pin_${String(value.closes.key)}, false);`,
							);
							callbackStarts.push(`mal_ffi_close_start(${context});`);
						}
						if (value.replaced !== undefined) {
							const key = value.replaced.key;
							replacedIndexes.add(index);
							locals.push(`MalFfiReplacement ${transaction} = {};`);
							keeps.push(
								`if (!mal_ffi_replace_prepare(vm, &${replaced}, ${key === undefined ? "nullptr" : `(void *) mal_argument_${String(key)}`}, ${context}, &${transaction})) goto mal_done;`,
							);
							// Close completion must snapshot this registration in its lifetime cutoff.
							commits.unshift(`mal_ffi_replace_commit(&${transaction});`);
							if (value.returnLifetime === "registration")
								callbackReturns.push(`mal_ffi_replace_return(&${transaction});`);
							cleanup.push(
								`if (${transaction}.site == nullptr) mal_ffi_release(${context});`,
								`mal_ffi_replace_finish(&${transaction});`,
							);
						}
						return;
					}
					if (value.kind === "callback") {
						const trampoline = `mal_ffi_callback_${name}_${String(index)}`;
						// Without user data the call publishes its callback in a per-thread
						// slot, restoring the previous one for calls nested in a callback.
						const slot = value.params.includes("data")
							? undefined
							: `mal_ffi_scoped_${name}_${String(index)}`;
						if (slot !== undefined)
							trampolines.push("", `static _Thread_local MalFfiCallback *${slot};`);
						trampolines.push(...this.#trampoline(trampoline, value, name, slot));
						locals.push(`MalFfiCallback mal_callback_${String(index)} = {};`);
						if (value.returnLifetime !== undefined)
							cleanup.push(
								`mal_ffi_callback_results_free(&mal_callback_${String(index)});`,
							);
						if (slot !== undefined) {
							locals.push(`MalFfiCallback *mal_scoped_${String(index)} = ${slot};`);
							cleanup.push(`${slot} = mal_scoped_${String(index)};`);
						}
						body.push(
							`if (!mal_ffi_to_function(vm, ${source}, ${value.nullable}, ${site})) goto mal_done;`,
							`mal_ffi_callback_init(&mal_callback_${String(index)}, vm, ${source});`,
							...(slot === undefined
								? []
								: [`${slot} = &mal_callback_${String(index)};`]),
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
						// Arrays of records with immediate fields read every element in one call.
						const elementRecord =
							value.of.kind === "record" ? this.#record(value.of.name) : undefined;
						const bulk =
							elementRecord === undefined || !immediateRecord(elementRecord)
								? undefined
								: {
										name: elementRecord.name,
										fields: String(elementRecord.fields.length),
										values: `mal_values_${String(index)}`,
										storage: `mal_value_storage_${String(index)}`,
										inline: "64",
									};
						if (bulk !== undefined) {
							locals.push(
								`MalValue ${bulk.storage}[${bulk.inline}];`,
								`MalValue *${bulk.values} = nullptr;`,
							);
							cleanup.push(
								`if (${bulk.values} != ${bulk.storage}) free(${bulk.values});`,
							);
						}
						const sequential = [
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
										false,
										inputs,
									).map((line) => `\t${line}`)),
							"}",
						];
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
							...(bulk === undefined
								? sequential
								: [
										`if ((size_t) ${length} * ${bulk.fields} <= ${bulk.inline}) ${bulk.values} = ${bulk.storage};`,
										`else if (${length} > 0) {`,
										`\t${bulk.values} = malloc(sizeof(MalValue) * (size_t) ${length} * ${bulk.fields});`,
										`\tif (${bulk.values} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
										"}",
										`if (${length} > 0 && mal_ffi_try_record_elements(vm, ${source}, ${length}, &mal_ffi_record_${bulk.name}, ${bulk.values})) {`,
										`\tfor (int32_t ${position} = 0; ${position} < ${length}; ${position}++) {`,
										`\t\tif (!mal_ffi_fields_${bulk.name}(vm, ${bulk.values} + (size_t) ${position} * ${bulk.fields}, ${site}, &${elements}[${position}])) goto mal_done;`,
										"\t}",
										"} else {",
										...sequential.map((line) => `\t${line}`),
										"}",
									]),
							`${local} = (${localDeclaration(param.type, "")}) ${elements};`,
						);
						setCount(index, length, site, body);
						return;
					}
					if (
						value.kind === "handle" &&
						(runsJavaScript ||
							binding.closes === entry.param ||
							this.managedFamily(value.name))
					) {
						// Pinned, so JavaScript that runs during the call cannot close it under C.
						const handle = this.#handle(value.name);
						const pointer = `mal_handle_${String(index)}`;
						const pin = `mal_handle_pin_${String(index)}`;
						locals.push(`void *${pointer};`, `void *${pin} = nullptr;`);
						const managed = this.managedFamily(value.name);
						cleanup.push(
							...(managed
								? [`mal_ffi_end_handle_use(vm, ${pin}, &mal_result, ${site}, true);`]
								: []),
							`mal_ffi_unpin_handle(${pin});`,
						);
						body.push(
							`if (!mal_ffi_to_handle(vm, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${pointer}, &${pin})) goto mal_done;`,
							...(managed
								? [
										`if (!mal_ffi_begin_handle_use(vm, ${pin}, &mal_result, ${site})) goto mal_done;`,
									]
								: []),
							...(binding.closes === entry.param
								? [
										`if (!mal_ffi_begin_handle_close(vm, ${pin}, false, ${site})) goto mal_done;`,
									]
								: []),
							value.pass === "copy"
								? `${local} = *(${handle.spelling} *) ${pointer};`
								: `${local} = (${localDeclaration(param.type, "")}) ${pointer};`,
						);
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
							true,
							inputs,
							borrowString(param.type),
						),
					);
					return;
				}
			}
		});
		const call = `${callable === undefined ? declaration.name : "mal_target"}(${declaration.params.map((_, index) => `mal_argument_${String(index)}`).join(", ")})`;
		const closing =
			binding.closes === undefined ? undefined : binding.params[binding.closes]!.value;
		const success =
			closing?.kind === "handle"
				? this.#handle(closing.name).destroy?.success
				: undefined;
		const closes =
			binding.closes === undefined
				? []
				: [
						`mal_ffi_finish_handle_close(${argument(binding.closes)}, ${success === undefined ? "true" : `mal_return == (${success})`});`,
					];
		const count = countValue(binding, binding.resultCount);
		const after: Array<string> = [];
		// A kept callback the library never received goes back if the C call never ran.
		const keptIndexes = binding.arguments.flatMap((_, index) =>
			keptCallback(index) && !replacedIndexes.has(index) ? [index] : [],
		);
		if (keptIndexes.length > 0) {
			locals.push("bool mal_called = false;");
			cleanup.push(
				...keptIndexes.map(
					(index) => `if (!mal_called) mal_ffi_release(mal_kept_${String(index)});`,
				),
			);
		}
		const enter = [
			...(keptIndexes.length > 0 ? ["mal_called = true;"] : []),
			...(callsBack ? ["if (mal_framed) mal_ffi_collectable_begin(vm);"] : []),
		];
		const leave = callsBack ? ["if (mal_framed) mal_ffi_collectable_end(vm);"] : [];
		if (binding.returns.kind === "undefined") {
			after.push(...enter, `${call};`, ...callbackReturns, ...leave, ...closes);
		} else if (binding.returns.kind === "array" && binding.global?.access === "get") {
			locals.push(`${globalArrayStorage(binding)} *mal_return = nullptr;`);
			after.push(
				"mal_return = malloc(sizeof(*mal_return));",
				"if (mal_return == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }",
				`${declaration.name}(mal_return);`,
				...this.#produce(binding.returns, "(*mal_return)", "mal_result"),
			);
			cleanup.push("free(mal_return);");
		} else {
			locals.push(
				`${binding.returns.kind === "callable" ? `${binding.returns.targetType} mal_return` : localDeclaration(declaration.returns, "mal_return")};`,
			);
			const owned = this.#owned(
				binding.returns,
				"mal_return",
				"mal_result",
				count,
				"&mal_site_result",
				callsBack,
			);
			const record = intoRecord(binding);
			after.push(
				...enter,
				`mal_return = ${call};`,
				...callbackReturns,
				...leave,
				...closes,
				...(record === undefined
					? owned
					: [
							// A compiled caller's stack object takes the fields instead of a new object.
							"if (mal_into != nullptr) {",
							`\tif (${callsBack ? "!mal_ffi_threw(vm) && " : ""}mal_ffi_fill_${record}(vm, mal_return, mal_slots, false)) mal_ffi_stack_record(vm, &mal_ffi_record_${record}, mal_into, mal_slots);`,
							"} else {",
							...owned.map((line) => `\t${line}`),
							"}",
						]),
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
				`static MalFfiRecordType mal_output_type = { mal_output_fields, ${String(fields.length)}, 0, nullptr };`,
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
						countValue(binding, output.count),
						"&mal_site_result",
						true,
					),
				);
			});
			after.push(
				"if (!mal_ffi_threw(vm)) {",
				// A compiled caller's stack object takes the fields instead of a new object.
				"\tif (mal_into != nullptr) {",
				"\t\t__builtin_memcpy(mal_slots, mal_outputs, sizeof(mal_outputs));",
				"\t\tmal_ffi_stack_record(vm, &mal_output_type, mal_into, mal_slots);",
				"\t} else mal_result = mal_ffi_new_record(vm, &mal_output_type, mal_outputs);",
				"}",
				"mal_ffi_unroot(&mal_output_roots);",
				"if (mal_ffi_threw(vm)) mal_result = mal_ffi_undefined();",
			);
		}
		return [
			...trampolines,
			"",
			// The body, shared by the function object (framed: the call counts as a native
			// frame, so collection needs lifting around callbacks) and the direct entry.
			`static inline MalValue mal_ffi_call_${name}(MalVm *vm, const MalValue *mal_args, int32_t mal_argc, bool mal_framed${hasInto(binding) ? ", void *mal_into, MalValue *mal_slots" : ""}${callable === undefined ? "" : `, MalFfiTarget_${callable.name} mal_target`}${owner === undefined ? "" : ", void *mal_owner_pin, MalValue mal_owner"}) {`,
			"\t(void) vm;",
			"\t(void) mal_args;",
			"\t(void) mal_argc;",
			"\t(void) mal_framed;",
			...(owner === undefined ? [] : ["\t(void) mal_owner;"]),
			"\tMalValue mal_result = mal_ffi_undefined();",
			...(binding.returns.kind === "array"
				? [
						"\tMalFfiRoots mal_result_roots;",
						"\tmal_ffi_root(&mal_result_roots, &mal_result, 1);",
					]
				: []),
			...strings.flatMap((temporary) => [
				`\tMalFfiString ${temporary};`,
				`\t${temporary}.data = nullptr;`,
			]),
			...locals.map((line) => `\t${line}`),
			...(compoundInputs
				? ["\tmal_ffi_inputs_init(&mal_inputs, &mal_result, false);"]
				: []),
			...(owner === undefined
				? []
				: [
						"\tif (!mal_ffi_begin_handle_use(vm, mal_owner_pin, &mal_result, &mal_site_result)) goto mal_done;",
					]),
			...body.map((line) => `\t${line}`),
			...this.#resultGuards(binding, "goto mal_done;").map((line) => `\t${line}`),
			...buffers.map((line) => `\t${line}`),
			...keeps.map((line) => `\t${line}`),
			...kept.map((line) => `\t${line}`),
			...commits.map((line) => `\t${line}`),
			...callbackStarts.map((line) => `\t${line}`),
			...after.map((line) => `\t${line}`),
			"\tgoto mal_done;",
			"mal_done:",
			...strings.map((temporary) => `\tmal_ffi_string_release(&${temporary});`),
			...cleanup.map((line) => `\t${line}`),
			...(compoundInputs
				? ["\tmal_ffi_inputs_release(vm, &mal_inputs, &mal_site_result, true);"]
				: []),
			...(owner === undefined
				? []
				: [
						"\tmal_ffi_end_handle_use(vm, mal_owner_pin, &mal_result, &mal_site_result, true);",
						"\tmal_ffi_unpin_handle(mal_owner_pin);",
					]),
			...(binding.returns.kind === "array"
				? ["\tmal_ffi_unroot(&mal_result_roots);"]
				: []),
			"\treturn mal_result;",
			"}",
			"",
			`static MalValue mal_ffi_function_${name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
			"\t(void) mal_this;",
			"\t(void) mal_new_target;",
			"\t(void) mal_callee;",
			...(callable === undefined
				? []
				: [
						`\tMalFfiTarget_${callable.name} mal_target;`,
						...(owner === undefined
							? []
							: ["\tvoid *mal_owner_pin = nullptr;", "\tMalValue mal_owner;"]),
						`\tstatic const MalFfiSite mal_site = { ${cString(callable.site)}, "callee", nullptr };`,
						`\tif (!mal_ffi_callable_target(vm, mal_callee, mal_ffi_function_${name}, &mal_target, sizeof(mal_target), ${owner === undefined ? "nullptr, nullptr, nullptr" : `&mal_ffi_type_${owner}, &mal_owner_pin, &mal_owner`}, &mal_site)) return mal_ffi_undefined();`,
					]),
			`\treturn mal_ffi_call_${name}(vm, mal_args, mal_argc, true${hasInto(binding) ? ", nullptr, nullptr" : ""}${callable === undefined ? "" : ", mal_target"}${owner === undefined ? "" : ", mal_owner_pin, mal_owner"});`,
			"}",
		];
	}

	/**
	 * The export that runs a binding's C call on a worker thread: its function converts
	 * the arguments into a context, then `mal_ffi_async` runs the call and completes the
	 * returned promise with the converted result on the VM thread. Handles and buffers
	 * stay pinned, and their objects reachable, until then.
	 */
	asyncFunction(binding: BoundFunction, exported: string): Array<string> {
		const name = binding.name;
		const declaration = binding.declaration;
		const context = `MalFfiAsync_${name}`;
		const callbacks: Array<{
			readonly index: number;
			readonly slot?: string;
			readonly retained: boolean;
			readonly replacement?: string;
			readonly closeKey?: number;
			readonly registrationResult: boolean;
		}> = [];
		const callbackArguments: Array<string> = [];
		const trampolines: Array<string> = [];
		const discard = (value: JsValue, expression: string): Array<string> => {
			if ("free" in value && value.free !== undefined)
				return [
					`if ((${expression}) != nullptr) ${value.free}((void *) (${expression}));`,
				];
			if (value.kind !== "handle" || !value.owned) return [];
			const handle = this.#handle(value.name);
			if (handle.destroy === undefined) return [];
			return handle.representation === "struct"
				? [`mal_ffi_destroy_${handle.name}(&(${expression}));`]
				: [
						`if ((${expression}) != nullptr) mal_ffi_destroy_${handle.name}((void *) (${expression}));`,
					];
		};
		const nativeDisposals = [
			...discard(binding.returns, "mal_ctx->mal_return"),
			...binding.outputs.flatMap((output, index) =>
				discard(output.value, `mal_ctx->mal_output_${String(index)}`),
			),
		];
		const tracksRun =
			binding.closes !== undefined ||
			nativeDisposals.length > 0 ||
			binding.params.some(({ value }) => value.kind === "callback" && value.kept);
		const fields: Array<string> = [];
		if (tracksRun) fields.push("bool mal_ran;");
		if (nativeDisposals.length > 0) fields.push("bool mal_result_observed;");
		const body: Array<string> = [];
		/** Buffers resolve last: nothing may run JavaScript between them and the call. */
		const buffers: Array<string> = [];
		const locals: Array<string> = [];
		const pins: Array<string> = [];
		/** What the context owns beyond its strings: array copies and their texts. */
		const frees: Array<string> = [];
		const strings: Array<string> = [];
		const compoundInputs = this.#compoundInputs(binding);
		const inputs = compoundInputs ? "&mal_ctx->mal_inputs" : "nullptr";
		const closing =
			binding.closes === undefined ? undefined : binding.params[binding.closes]!.value;
		const closeSuccess =
			closing?.kind === "handle"
				? this.#handle(closing.name).destroy?.success
				: undefined;
		if (binding.closes !== undefined)
			fields.push("MalValue mal_closing;", "bool mal_close_started;");
		if (compoundInputs) fields.push("MalFfiInputs mal_inputs;");
		const managedHandles = binding.arguments.some((entry) => {
			if (entry.kind !== "input") return false;
			const value = binding.params[entry.param]!.value;
			return value.kind === "handle" && this.managedFamily(value.name);
		});
		if (managedHandles) locals.push("bool mal_validate = false;");
		if (managedHandles || compoundInputs || this.#resultGuards(binding, "").length > 0)
			locals.push(
				`static const MalFfiSite mal_site_result = { ${cString(exported)}, "result", nullptr };`,
			);
		let kept = 0;
		const argument = (param: number) =>
			`mal_argc > ${String(param)} ? mal_args[${String(param)}] : mal_ffi_undefined()`;
		// Errors name the export the program called.
		binding.params.forEach((param, index) => {
			locals.push(
				`static const MalFfiSite mal_site_${String(index)} = { ${cString(exported)}, ${cString(param.name)}, nullptr };`,
			);
		});
		const setCount = (counted: number, count: string, site: string): void => {
			const index = binding.arguments.findIndex(
				(entry) => entry.kind === "count" && entry.of === counted,
			);
			if (index < 0) return;
			const entry = binding.arguments[index];
			const output = entry?.kind === "count" ? entry.output : undefined;
			const type =
				output === undefined
					? declaration.params[index]!.type
					: binding.outputs[output]!.type;
			const integer = resolveCType(this.#model, type);
			const bits =
				integer.kind === "integer"
					? (this.#model.target.sizes[integer.name] ?? 4) * 8
					: 32;
			const signed =
				integer.kind === "integer" &&
				(integer.name === "char"
					? this.#model.target.charSigned
					: !integer.name.startsWith("unsigned"));
			buffers.push(
				`if (!mal_ffi_check_count(vm, (size_t) (${count}), ${bits}, ${signed}, ${site})) goto mal_failed;`,
				...(output === undefined
					? [
							`mal_ctx->mal_argument_${String(index)} = (${localDeclaration(type, "")}) (${count});`,
						]
					: [
							`mal_ctx->mal_output_${String(output)} = (${localDeclaration(type, "")}) (${count});`,
							`mal_ctx->mal_argument_${String(index)} = &mal_ctx->mal_output_${String(output)};`,
						]),
			);
		};
		binding.arguments.forEach((entry, index) => {
			const param = declaration.params[index]!;
			const target = `mal_ctx->mal_argument_${String(index)}`;
			fields.push(`${localDeclaration(param.type, `mal_argument_${String(index)}`)};`);
			const resolved = resolveCType(this.#model, param.type);
			const pointee = resolved.kind === "pointer" ? resolved.to : param.type;
			switch (entry.kind) {
				case "count":
					if (entry.output !== undefined) {
						fields.push(
							`${localDeclaration(pointee, `mal_output_${String(entry.output)}`)};`,
						);
						body.push(`${target} = &mal_ctx->mal_output_${String(entry.output)};`);
					}
					return;
				case "result-count":
					fields.push(`${localDeclaration(pointee, "mal_count")};`);
					body.push(`${target} = &mal_ctx->mal_count;`);
					return;
				case "constant":
					if (entry.sizeLimit !== undefined)
						locals.push(
							`static_assert(${entry.expression} <= UINT64_C(${entry.sizeLimit}), "C type size exceeds parameter range");`,
						);
					body.push(`${target} = ${entry.expression};`);
					return;
				case "callback-data":
					callbackArguments.push(
						`${target} = mal_ctx->mal_callback_${String(entry.of)};`,
					);
					return;
				case "callback-release":
					callbackArguments.push(
						`${target} = mal_ctx->mal_callback_${String(entry.of)} == nullptr ? nullptr : mal_ffi_release;`,
					);
					return;
				case "out":
				case "inout": {
					const output = `mal_output_${String(entry.output)}`;
					fields.push(`${localDeclaration(pointee, output)};`);
					if (entry.kind === "inout") {
						const value = binding.params[entry.param]!.value;
						if (value.kind === "string" && value.counted) {
							const text = this.#fresh("string");
							const site = `&mal_site_${String(entry.param)}`;
							strings.push(text);
							body.push(
								`if (!mal_ffi_to_string(vm, ${argument(entry.param)}, ${value.nullable}, MAL_FFI_STRING_COUNTED, ${site}, &${text})) goto mal_failed;`,
								`mal_ctx->${output} = (${localDeclaration(pointee, "")}) ${text}.data;`,
							);
							setCount(index, `${text}.length`, site);
						} else
							body.push(
								...this.read(
									binding.params[entry.param]!.value,
									pointee,
									argument(entry.param),
									`mal_ctx->${output}`,
									`&mal_site_${String(entry.param)}`,
									"goto mal_failed;",
									strings,
									true,
									inputs,
								),
							);
					}
					body.push(`${target} = &mal_ctx->${output};`);
					return;
				}
				case "input": {
					const value = binding.params[entry.param]!.value;
					const site = `&mal_site_${String(entry.param)}`;
					const source = argument(entry.param);
					if (value.kind === "callback") {
						const trampoline =
							value.replaced === undefined
								? `mal_ffi_async_callback_${name}_${String(index)}`
								: `mal_ffi_async_replacement_callback_${String(name.length)}_${name}_${String(index)}`;
						const field = `mal_callback_${String(index)}`;
						const slot =
							value.params.includes("data") ||
							value.lookup !== undefined ||
							value.replaced !== undefined ||
							value.closes !== undefined
								? undefined
								: `mal_ffi_async_scoped_${name}_${String(index)}`;
						callbacks.push({
							index,
							retained: value.kept,
							registrationResult: value.returnLifetime === "registration",
							...(value.closes === undefined ? {} : { closeKey: value.closes.key }),
							...(value.replaced === undefined
								? {}
								: { replacement: `mal_replacement_${String(index)}` }),
							...(slot === undefined ? {} : { slot }),
						});
						fields.push(`MalFfiCallback *${field};`);
						const replacement = `mal_replacement_${String(index)}`;
						const replacedSite = `mal_ffi_replaced_${name}_${String(index)}`;
						const lanes =
							value.replaced !== undefined &&
							!value.params.includes("data") &&
							value.lookup === undefined;
						if (value.replaced !== undefined)
							fields.push(`MalFfiReplacement ${replacement};`);
						if (slot !== undefined)
							trampolines.push("", `static _Thread_local MalFfiCallback *${slot};`);
						for (const lane of lanes ? [0, 1] : [0])
							trampolines.push(
								...this.#trampoline(
									lanes ? `${trampoline}_${String(lane)}` : trampoline,
									{ ...value, kept: true, queued: value.queued ?? "wait" },
									exported,
									value.replaced === undefined && value.closes === undefined
										? slot
										: replacedSite,
									lane,
								),
							);
						body.push(
							`if (!mal_ffi_to_function(vm, ${source}, ${value.nullable}, ${site})) goto mal_failed;`,
						);
						buffers.push(
							`if ((${source}) != mal_ffi_null()) {`,
							`\tmal_ctx->${field} = mal_ffi_keep_queued(vm, ${source});`,
							`\tif (mal_ctx->${field} == nullptr) goto mal_failed;`,
							"}",
						);
						callbackArguments.push(
							...(value.closes === undefined
								? []
								: [
										`if (!mal_ffi_close_prepare(vm, mal_ctx->${field}, ${argument(value.closes.param)}, &${replacedSite}, ${site})) goto mal_failed;`,
									]),
							...(value.replaced === undefined
								? []
								: [
										`if (!mal_ffi_replace_prepare(vm, &${replacedSite}, ${value.replaced.key === undefined ? "nullptr" : `(void *) mal_ctx->mal_argument_${String(value.replaced.key)}`}, mal_ctx->${field}, &mal_ctx->${replacement})) goto mal_failed;`,
									]),
							`${target} = mal_ctx->${field} == nullptr ? nullptr : ${lanes ? `(mal_ctx->${replacement}.lane == 0 ? ${trampoline}_0 : ${trampoline}_1)` : trampoline};`,
						);
						return;
					}
					if (value.kind === "string" && value.counted) {
						const text = this.#fresh("string");
						strings.push(text);
						body.push(
							`if (!mal_ffi_to_string(vm, ${source}, ${value.nullable}, MAL_FFI_STRING_COUNTED, ${site}, &${text})) goto mal_failed;`,
							`${target} = (${localDeclaration(param.type, "")}) ${text}.data;`,
						);
						setCount(index, `${text}.length`, site);
						return;
					}
					if (value.kind === "bytes") {
						const pin = `mal_pin_${String(index)}`;
						fields.push(`void *${pin};`);
						pins.push(`mal_ffi_unpin(mal_ctx->${pin});`);
						locals.push(
							`void *mal_bytes_${String(index)};`,
							`size_t mal_bytes_length_${String(index)};`,
						);
						buffers.push(
							`if (!mal_ffi_to_bytes(vm, ${source}, ${value.nullable}, ${value.writable === true}, ${site}, &mal_bytes_${String(index)}, &mal_bytes_length_${String(index)}, &mal_ctx->${pin})) goto mal_failed;`,
							`mal_keep[${String(kept++)}] = ${source};`,
							`${target} = (${localDeclaration(param.type, "")}) mal_bytes_${String(index)};`,
						);
						setCount(index, `mal_bytes_length_${String(index)}`, site);
						return;
					}
					if (value.kind === "sequence") {
						// The context owns a copy of the elements, since the call outlives this frame.
						const elements = `mal_elements_${String(index)}`;
						const length = `mal_length_${String(index)}`;
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						const texts = value.of.kind === "string";
						fields.push(
							`${localDeclaration(value.element, `*${elements}`)};`,
							`int32_t ${length};`,
						);
						if (texts) {
							const freed = this.#fresh("index");
							frees.push(
								`if (mal_ctx->${elements} != nullptr) for (int32_t ${freed} = 0; ${freed} < mal_ctx->${length}; ${freed}++) free((void *) mal_ctx->${elements}[${freed}]);`,
							);
						}
						frees.push(`free(mal_ctx->${elements});`);
						body.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &mal_ctx->${length})) goto mal_failed;`,
							`if (mal_ctx->${length} > 0) {`,
							`\tmal_ctx->${elements} = calloc((size_t) mal_ctx->${length}, sizeof(*mal_ctx->${elements}));`,
							`\tif (mal_ctx->${elements} == nullptr) {`,
							"\t\tmal_ffi_out_of_memory(vm);",
							"\t\tgoto mal_failed;",
							"\t}",
							"}",
							`for (int32_t ${position} = 0; ${position} < mal_ctx->${length}; ${position}++) {`,
							`\tMalValue ${element};`,
							`\tif (!mal_ffi_element(vm, ${source}, ${position}, mal_ctx->${length}, ${site}, &${element})) goto mal_failed;`,
							...(texts
								? [
										`\tchar *${element}_text;`,
										`\tif (!mal_ffi_to_owned_string(vm, ${element}, ${site}, &${element}_text)) goto mal_failed;`,
										`\tmal_ctx->${elements}[${position}] = ${element}_text;`,
									]
								: this.read(
										value.of,
										value.element,
										element,
										`mal_ctx->${elements}[${position}]`,
										site,
										"goto mal_failed;",
										strings,
										false,
										inputs,
									).map((line) => `\t${line}`)),
							"}",
							`${target} = (${localDeclaration(param.type, "")}) mal_ctx->${elements};`,
						);
						setCount(index, `mal_ctx->${length}`, site);
						return;
					}
					if (value.kind === "handle") {
						const handle = this.#handle(value.name);
						const pointer = `mal_handle_${String(index)}`;
						const pin = `mal_handle_pin_${String(index)}`;
						fields.push(`void *${pin};`);
						const managed = this.managedFamily(value.name);
						pins.push(
							...(managed
								? [
										`mal_ffi_end_handle_use(vm, mal_ctx->${pin}, mal_ctx, &mal_site_result, mal_validate);`,
									]
								: []),
							`mal_ffi_unpin_worker_handle(mal_ctx->${pin});`,
						);
						locals.push(`void *${pointer};`);
						body.push(
							`if (!mal_ffi_to_worker_handle(vm, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${pointer}, &mal_ctx->${pin})) goto mal_failed;`,
							...(managed
								? [
										`if (!mal_ffi_begin_handle_use(vm, mal_ctx->${pin}, mal_ctx, ${site})) goto mal_failed;`,
									]
								: []),
							`mal_keep[${String(kept++)}] = ${source};`,
							value.pass === "copy"
								? `${target} = *(${handle.spelling} *) ${pointer};`
								: `${target} = (${localDeclaration(param.type, "")}) ${pointer};`,
						);
						if (binding.closes === entry.param) {
							body.push(`mal_ctx->mal_closing = ${source};`);
							buffers.push(
								`if (!mal_ffi_begin_handle_close(vm, mal_ctx->${pin}, true, ${site})) goto mal_failed;`,
								"mal_ctx->mal_close_started = true;",
							);
						}
						return;
					}
					body.push(
						...this.read(
							value,
							param.type,
							source,
							target,
							site,
							"goto mal_failed;",
							strings,
							true,
							inputs,
						),
					);
					return;
				}
			}
		});
		const returns = binding.returns.kind !== "undefined";
		if (returns)
			fields.push(
				`${binding.returns.kind === "callable" ? `${binding.returns.targetType} mal_return` : localDeclaration(declaration.returns, "mal_return")};`,
			);
		for (const temporary of strings) fields.push(`MalFfiString ${temporary};`);
		const call = `${declaration.name}(${declaration.params.map((_, index) => `mal_ctx->mal_argument_${String(index)}`).join(", ")})`;
		const count = countValue(binding, binding.resultCount, "mal_ctx->");
		const produce: Array<string> = returns
			? this.#owned(
					binding.returns,
					"mal_ctx->mal_return",
					"mal_result",
					count,
					"&mal_site_result",
					true,
				)
			: [];
		if (binding.outputs.length > 0) {
			const keys = [
				...(returns ? ["result"] : []),
				...binding.outputs.map((output) => output.name),
			];
			const first = keys.length - binding.outputs.length;
			produce.push(
				`static const char *const mal_output_fields[] = { ${keys.map(cString).join(", ")} };`,
				`static MalFfiRecordType mal_output_type = { mal_output_fields, ${String(keys.length)}, 0, nullptr };`,
				`MalValue mal_outputs[${String(keys.length)}] = { ${first === 1 ? "mal_result" : "0"} };`,
				"MalFfiRoots mal_output_roots;",
				`mal_ffi_root(&mal_output_roots, mal_outputs, ${String(keys.length)});`,
				...binding.outputs.flatMap((output, index) =>
					this.#owned(
						output.value,
						`mal_ctx->mal_output_${String(index)}`,
						`mal_outputs[${String(first + index)}]`,
						countValue(binding, output.count, "mal_ctx->"),
						"&mal_site_result",
						true,
					),
				),
				"if (!mal_ffi_threw(vm)) mal_result = mal_ffi_new_record(vm, &mal_output_type, mal_outputs);",
				"mal_ffi_unroot(&mal_output_roots);",
				"if (mal_ffi_threw(vm)) mal_result = mal_ffi_undefined();",
			);
		}
		const keep = String(Math.max(kept, 1));
		return [
			"",
			...trampolines,
			`typedef struct ${context} {`,
			...fields.map((line) => `\t${line}`),
			...(fields.length === 0 ? ["\tchar mal_unused;"] : []),
			`} ${context};`,
			"",
			`static void mal_ffi_async_run_${name}(void *mal_data) {`,
			`\t${context} *mal_ctx = mal_data;`,
			"\t(void) mal_ctx;",
			...callbacks.flatMap(({ index, slot }) =>
				slot === undefined
					? []
					: [
							`\tMalFfiCallback *mal_previous_${String(index)} = ${slot};`,
							`\t${slot} = mal_ctx->mal_callback_${String(index)};`,
						],
			),
			...callbacks.flatMap(({ replacement }) =>
				replacement === undefined
					? []
					: [`\tmal_ffi_replace_commit(&mal_ctx->${replacement});`],
			),
			...callbacks.flatMap(({ index, closeKey }) =>
				closeKey === undefined
					? []
					: [`\tmal_ffi_close_start(mal_ctx->mal_callback_${String(index)});`],
			),
			`\t${returns ? "mal_ctx->mal_return = " : ""}${call};`,
			...callbacks.flatMap(({ replacement, registrationResult }) =>
				replacement !== undefined && registrationResult
					? [`\tmal_ffi_replace_return(&mal_ctx->${replacement});`]
					: [],
			),
			...callbacks.flatMap(({ index, slot }) =>
				slot === undefined ? [] : [`\t${slot} = mal_previous_${String(index)};`],
			),
			...(tracksRun ? ["\tmal_ctx->mal_ran = true;"] : []),
			"}",
			"",
			`static MalValue mal_ffi_async_complete_${name}(MalVm *vm, void *mal_data, bool mal_ran) {`,
			`\t${context} *mal_ctx = mal_data;`,
			`\tstatic const MalFfiSite mal_site_result = { ${cString(exported)}, "result", nullptr };`,
			"\t(void) mal_site_result;",
			"\tMalValue mal_result = mal_ffi_undefined();",
			...(managedHandles ? ["\tbool mal_validate = mal_ran;"] : []),
			...pins.map((line) => `\t${line}`),
			...(compoundInputs
				? [
						"\tmal_ffi_inputs_release(vm, &mal_ctx->mal_inputs, &mal_site_result, mal_ran);",
					]
				: []),
			...(binding.closes === undefined
				? []
				: [
						"\tif (mal_ran && mal_ctx->mal_close_started) {",
						`\t\tmal_ffi_finish_handle_close(mal_ctx->mal_closing, ${closeSuccess === undefined ? "true" : `mal_ctx->mal_return == (${closeSuccess})`});`,
						"\t\tmal_ctx->mal_close_started = false;",
						"\t}",
					]),
			"\tif (!mal_ran) return mal_result;",
			...(nativeDisposals.length === 0 ? [] : ["\tmal_ctx->mal_result_observed = true;"]),
			...produce.map((line) => `\t${line}`),
			"\tgoto mal_done;",
			"mal_done:",
			"\treturn mal_result;",
			"}",
			"",
			`static void mal_ffi_async_release_${name}(void *mal_data) {`,
			`\t${context} *mal_ctx = mal_data;`,
			...(binding.closes === undefined
				? []
				: [
						`\tif (mal_ctx->mal_close_started) mal_ffi_finish_handle_close(mal_ctx->mal_closing, mal_ctx->mal_ran${closeSuccess === undefined ? "" : ` && mal_ctx->mal_return == (${closeSuccess})`});`,
					]),
			...(nativeDisposals.length === 0
				? []
				: [
						"\tif (mal_ctx->mal_ran && !mal_ctx->mal_result_observed) {",
						...nativeDisposals.map((line) => `\t\t${line}`),
						"\t}",
					]),
			...strings.map((temporary) => `\tmal_ffi_string_release(&mal_ctx->${temporary});`),
			...frees.map((line) => `\t${line}`),
			...callbacks.map(({ index, retained, replacement }) =>
				replacement === undefined
					? `\t${retained ? "if (!mal_ctx->mal_ran) " : ""}mal_ffi_release(mal_ctx->mal_callback_${String(index)});`
					: `\tif (mal_ctx->${replacement}.site == nullptr) mal_ffi_release(mal_ctx->mal_callback_${String(index)});\n\tmal_ffi_replace_finish(&mal_ctx->${replacement});`,
			),
			"\tfree(mal_ctx);",
			"}",
			"",
			// String conversions name their temporaries; these live in the context.
			...strings.map((temporary) => `#define ${temporary} (mal_ctx->${temporary})`),
			`static MalValue mal_ffi_function_${exported}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
			"\t(void) mal_this;",
			"\t(void) mal_new_target;",
			"\t(void) mal_callee;",
			...locals.map((line) => `\t${line}`),
			`\t${context} *mal_ctx = calloc(1, sizeof(*mal_ctx));`,
			"\tif (mal_ctx == nullptr) {",
			"\t\tmal_ffi_out_of_memory(vm);",
			"\t\treturn mal_ffi_rejected(vm);",
			"\t}",
			`\tMalValue mal_keep[${keep}] = {};`,
			"\tMalFfiRoots mal_keep_roots;",
			`\tmal_ffi_root(&mal_keep_roots, mal_keep, ${keep});`,
			"\tMalValue mal_promise = mal_ffi_undefined();",
			...(compoundInputs
				? ["\tmal_ffi_inputs_init(&mal_ctx->mal_inputs, mal_ctx, true);"]
				: []),
			...body.map((line) => `\t${line}`),
			...this.#resultGuards(binding, "goto mal_failed;").map((line) => `\t${line}`),
			...buffers.map((line) => `\t${line}`),
			...callbackArguments.map((line) => `\t${line}`),
			...callbacks.flatMap(({ index, closeKey }) =>
				closeKey === undefined
					? []
					: [
							`\tmal_ffi_close_commit(mal_ctx->mal_callback_${String(index)}, &mal_ctx->mal_handle_pin_${String(closeKey)}, true);`,
						],
			),
			...(callbacks.length === 0
				? []
				: [
						`\tMalFfiCallback *mal_callbacks[] = { ${callbacks.map(({ index }) => `mal_ctx->mal_callback_${String(index)}`).join(", ")} };`,
					]),
			`\tif (mal_ffi_async(vm, mal_ctx, mal_ffi_async_run_${name}, mal_ffi_async_complete_${name}, mal_ffi_async_release_${name}, mal_keep, ${String(kept)}, ${inputs}, ${callbacks.length === 0 ? "nullptr" : "mal_callbacks"}, ${callbacks.length}, &mal_promise, ${binding.closes !== undefined || binding.params.some(({ value }) => value.kind === "callback" && value.closes !== undefined)})) {`,
			...(compoundInputs ? ["\t\tmal_ffi_inputs_unroot(&mal_ctx->mal_inputs);"] : []),
			"\t\tmal_ffi_unroot(&mal_keep_roots);",
			"\t\treturn mal_promise;",
			"\t}",
			"mal_failed:",
			...callbacks.flatMap(({ index, closeKey }) =>
				closeKey === undefined
					? []
					: [
							`\tmal_ffi_close_cancel(mal_ctx->mal_callback_${String(index)}, &mal_ctx->mal_handle_pin_${String(closeKey)});`,
						],
			),
			...(compoundInputs
				? ["\tmal_ffi_inputs_release(vm, &mal_ctx->mal_inputs, &mal_site_result, false);"]
				: []),
			...pins.map((line) => `\t${line}`),
			`\tmal_ffi_async_release_${name}(mal_ctx);`,
			"\tmal_ffi_unroot(&mal_keep_roots);",
			"\treturn mal_ffi_rejected(vm);",
			"}",
			...strings.map((temporary) => `#undef ${temporary}`),
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

/** Describe the host ABI without rendering C wrappers. */
export function describeBindingUnit(
	library: string,
	plan: BindingPlan,
): Omit<BindingUnit, "source"> {
	return {
		library,
		specifier: ffiModuleSpecifier(library),
		installer: ffiInstallerSymbol(library),
		exports: [
			...[...plan.handles.values()].flatMap((handle) =>
				handle.allocator === undefined ? [] : [handle.allocator],
			),
			...plan.functions.flatMap((binding) =>
				binding.async === undefined ? [binding.name] : [binding.name, binding.async],
			),
			...plan.constants.map((constant) => constant.name),
		].sort(byteOrder),
		direct: Object.fromEntries(
			plan.functions.map((binding) => {
				const result = directResult(binding);
				const borrows = binding.params.flatMap(({ value }, argument) =>
					value.kind === "record"
						? [
								{
									argument,
									fields: plan.records.get(value.name)!.fields.map((field) => field.name),
								},
							]
						: [],
				);
				const fields = intoFields(binding, plan.records);
				return [
					binding.name,
					{
						symbol: directSymbol(library, binding.name),
						arity: binding.params.length,
						callsUserCode:
							plan.hasCallbacks ||
							binding.params.some(({ value }) => inputCanRunJavaScript(value)),
						...(result === undefined ? {} : { result }),
						...(borrows.length === 0 ? {} : { borrows }),
						...(fields === undefined ? {} : { into: { fields } }),
					},
				];
			}),
		),
	};
}

/** Generate bindings for selected exports, or the complete declared surface. */
export function generateBindingUnit(
	library: string,
	headers: ReadonlyArray<string>,
	model: CModel,
	plan: BindingPlan,
	selectedExports?: ReadonlySet<string>,
): BindingUnit {
	const writer = new BindingWriter(model, plan);
	const bindings = plan.functions.filter(
		(binding) =>
			selectedExports === undefined ||
			selectedExports.has(binding.name) ||
			(binding.async !== undefined && selectedExports.has(binding.async)),
	);
	const selectedConstants = plan.constants.filter(
		(constant) => selectedExports === undefined || selectedExports.has(constant.name),
	);
	for (const binding of bindings) {
		for (const param of binding.params) writer.need(param.value, "input");
		for (const output of binding.outputs) writer.need(output.value, "output");
		writer.need(binding.returns, "output");
	}
	for (const constant of selectedConstants) writer.need(constant.value, "output");
	for (const handle of plan.handles.values()) {
		for (const field of handle.fields) writer.need(field.value, "output");
	}

	const functions = bindings.flatMap((binding) => [
		"",
		...writer.function(binding),
		...directEntry(
			library,
			binding,
			plan.hasCallbacks ||
				binding.params.some(
					({ value }) =>
						value.kind === "callback" ||
						(value.kind === "handle" && writer.managedFamily(value.name)),
				),
		),
		...(binding.async === undefined ? [] : writer.asyncFunction(binding, binding.async)),
	]);
	const constants = selectedConstants.flatMap((constant) => [
		"",
		...writer.constant(constant),
	]);
	const exports = [
		...[...plan.handles.values()].flatMap((handle) =>
			handle.allocator === undefined
				? []
				: [
						{
							name: handle.allocator,
							entry: `{ ${cString(handle.allocator)}, 0, mal_ffi_allocate_${handle.allocator}, nullptr }`,
						},
					],
		),
		...bindings.flatMap((binding) =>
			[binding.name, ...(binding.async === undefined ? [] : [binding.async])].map(
				(exported) => ({
					name: exported,
					entry: `{ ${cString(exported)}, ${String(binding.params.length)}, mal_ffi_function_${exported}, nullptr }`,
				}),
			),
		),
		...selectedConstants.map((constant) => ({
			name: constant.name,
			entry: `{ ${cString(constant.name)}, 0, nullptr, mal_ffi_constant_${constant.name} }`,
		})),
	]
		.filter((entry) => selectedExports === undefined || selectedExports.has(entry.name))
		.sort((left, right) => byteOrder(left.name, right.name));
	const specifier = ffiModuleSpecifier(library);
	const installer = ffiInstallerSymbol(library);
	const globalArrays = new Set<string>();
	const source = [
		`// Generated binding for ${specifier}.`,
		'#include "mal_ffi.h"',
		"#include <stdlib.h>",
		...headers.map((header) => `#include "${header}"`),
		"",
		...bindings.flatMap((binding) => {
			if (binding.global === undefined) return [];
			const name = binding.global.declaration.name;
			const array = resolveCType(model, binding.global.declaration.type);
			if (array.kind === "array") {
				const get = binding.global.access === "get";
				const storage = globalArrayStorage(binding);
				const declarations: Array<string> = [];
				if (!globalArrays.has(name)) {
					globalArrays.add(name);
					const dimensions: Array<number> = [];
					let element: CType = array;
					while (element.kind === "array") {
						dimensions.push(element.length!);
						element = resolveCType(model, element.of);
					}
					declarations.push(
						`typedef __typeof__((0, ${name}${"[0]".repeat(dimensions.length)})) ${storage}${dimensions.map((length) => `[${String(length)}]`).join("")};`,
					);
				}
				const type = get
					? binding.declaration.returns
					: binding.declaration.params[0]!.type;
				const copy = (
					type: CType,
					target: string,
					source: string,
					depth: number,
				): Array<string> => {
					const resolved = resolveCType(model, type);
					if (resolved.kind !== "array") return [`${target} = ${source};`];
					const index = `mal_index_${String(depth)}`;
					return [
						`for (size_t ${index} = 0; ${index} < ${String(resolved.length)}; ${index}++) {`,
						...copy(
							resolved.of,
							`${target}[${index}]`,
							`${source}[${index}]`,
							depth + 1,
						).map((line) => `\t${line}`),
						"}",
					];
				};
				return [
					...declarations,
					`static void ${binding.declaration.name}(${storage}${get ? " *" : " "}mal_value) {`,
					...copy(type, get ? "(*mal_value)" : name, get ? name : "mal_value", 0).map(
						(line) => `\t${line}`,
					),
					"}",
				];
			}
			return [
				binding.global.access === "get"
					? `static __typeof__(${name}) ${binding.declaration.name}(void) { return ${name}; }`
					: `static void ${binding.declaration.name}(__typeof__(${name}) mal_value) { ${name} = mal_value; }`,
			];
		}),
		// Tentative definitions: helpers refer to these before their initializers.
		"static const MalFfiLibrary mal_ffi_library;",
		...[...plan.handles.keys()].map(
			(name) => `static const MalFfiHandleType mal_ffi_type_${name};`,
		),
		"",
		...writer.callableDeclarations(),
		...writer.recordHelpers(),
		...writer.handleTypes(),
		...writer.callableHelpers(),
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
		...describeBindingUnit(library, {
			...plan,
			functions: bindings,
			constants: selectedConstants,
		}),
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
