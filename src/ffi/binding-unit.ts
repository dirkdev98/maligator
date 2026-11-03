import { ffiIntoSymbol } from "../build-config-values.ts";
import type { FfiDirectEntry, FfiDirectResult } from "../build-config-values.ts";
import type {
	BindingPlan,
	BoundFunction,
	Argument,
	HandleType,
	JsValue,
	MappedConstant,
	MappedRecord,
} from "./binding-plan.ts";
import type { CModel } from "./c-model.ts";
import { cRecordHasConstMembers, resolveCType } from "./c-model.ts";
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
	"native",
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
		case "native":
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

function pointerDeclaration(type: CType, name: string): string {
	const element =
		"const" in type && type.const === true ? { ...type, const: undefined } : type;
	return formatCDeclaration({ kind: "pointer", to: element }, name);
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
	readonly #taggedCaseInitializers = new Map<string, string>();
	readonly #managedFamilies = new Set<string>();
	readonly #viewFamilies = new Set<string>();
	readonly #ownerFamilies = new Set<string>();
	readonly #libraryFamilies = new Set<string>();
	readonly #viewFields = new Map<string, Array<{ handle: string; name: string }>>();
	readonly #workerCloseFamilies = new Set<string>();
	readonly #callables = new Map<string, Extract<JsValue, { kind: "callable" }>>();
	#counter = 0;

	constructor(model: CModel, plan: BindingPlan) {
		this.#model = model;
		this.#plan = plan;
		for (const tagged of plan.tagged.values()) {
			if (!cRecordHasConstMembers(model, tagged.record)) continue;
			for (const entry of tagged.cases)
				if (entry.initializeTag)
					this.#taggedCaseInitializers.set(
						entry.record.name,
						`.${tagged.tag.name} = ${entry.expression}`,
					);
		}
		for (const handle of plan.handles.values()) {
			if (handle.managedFields.length > 0) this.#managedFamilies.add(handle.family);
			if (handle.views.length > 0) this.#viewFamilies.add(handle.family);
			for (const field of handle.fields) {
				if (field.value.kind !== "handle") continue;
				if (field.value.owner !== undefined)
					this.#ownerFamilies.add(this.#handle(field.value.name).family);
				if (field.value.lifetime === "library")
					this.#libraryFamilies.add(this.#handle(field.value.name).family);
			}
		}
		for (const handle of plan.handles.values()) {
			if (!this.#viewFamilies.has(handle.family)) continue;
			const fields = this.#viewFields.get(handle.family) ?? [];
			for (const field of handle.fields)
				if (field.value.kind === "callable" || field.value.kind === "handle")
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

	#retainCallbackOwners(
		binding: BoundFunction,
		callback: string,
		argument: (index: number) => string,
		inputs: string,
		fail: string,
		owner?: string,
	): Array<string> {
		const checks = binding.params.flatMap(({ value }, index) =>
			value.kind === "handle"
				? [
						`if (!mal_ffi_callback_retain_owners(vm, ${callback}, ${argument(index)}, nullptr, &mal_site_${index})) ${fail}`,
					]
				: [],
		);
		if (inputs !== "nullptr" || owner !== undefined)
			checks.push(
				`if (!mal_ffi_callback_retain_owners(vm, ${callback}, ${owner ?? "mal_ffi_undefined()"}, ${inputs}, &mal_site_result)) ${fail}`,
			);
		return checks;
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

	#immutableRecord(type: CType): boolean {
		const resolved = resolveCType(this.#model, type);
		const record =
			resolved.kind === "record" ? this.#model.records.get(resolved.name) : undefined;
		return record !== undefined && cRecordHasConstMembers(this.#model, record);
	}

	#constStorage(type: CType): boolean {
		const resolved = resolveCType(this.#model, type);
		return resolved.kind === "array"
			? this.#constStorage(resolved.of)
			: ("const" in resolved && resolved.const === true) ||
					this.#immutableRecord(resolved);
	}

	#constArguments(binding: BoundFunction): ReadonlySet<number> {
		return new Set(
			binding.arguments.flatMap((entry, index) => {
				const value =
					entry.kind === "input" ? binding.params[entry.param]!.value : undefined;
				return (value?.kind === "record" ||
					value?.kind === "union" ||
					value?.kind === "tagged" ||
					(value?.kind === "handle" && value.pass === "copy")) &&
					this.#immutableRecord(binding.declaration.params[index]!.type)
					? [index]
					: [];
			}),
		);
	}

	#constOutputs(binding: BoundFunction): ReadonlySet<number> {
		return new Set(
			binding.outputs.flatMap((output, index) => {
				let type = resolveCType(this.#model, output.type);
				if (type.kind !== "array")
					return this.#immutableRecord(output.type) ? [index] : [];
				while (type.kind === "array") type = resolveCType(this.#model, type.of);
				return ("const" in type && type.const === true) || this.#immutableRecord(type)
					? [index]
					: [];
			}),
		);
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
	 * Convert `source` into `target`. `initializeRecord` declares the native copy,
	 * since const members cannot be assigned. `fail` leaves after a pending throw.
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
		initializeRecord = false,
	): Array<string> {
		const cast = (expression: string) =>
			`(${localDeclaration(type, "")}) (${expression})`;
		switch (value.kind) {
			case "native": {
				const temporary = this.#fresh("native");
				return [
					`void *${temporary};`,
					`if (!mal_ffi_to_handle(vm, ${source}, &mal_ffi_type_${value.name}, false, ${site}, &${temporary}, nullptr)) ${fail}`,
					`${target} = *(${value.name} *) ${temporary};`,
				];
			}
			case "handle": {
				const temporary = this.#fresh("handle");
				return [
					`void *${temporary};`,
					`if (!${inputs === "nullptr" ? `mal_ffi_to_handle(vm, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${temporary}, nullptr)` : `mal_ffi_input_handle(vm, ${inputs}, ${source}, &mal_ffi_type_${value.name}, ${value.nullable}, ${site}, &${temporary})`}) ${fail}`,
					value.pass === "copy"
						? `${initializeRecord ? localDeclaration(type, target) : target} = *(${this.#handle(value.name).spelling} *) ${temporary};`
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
			case "tagged":
			case "union":
			case "record": {
				const retained = this.#hasHandles(value) ? `, ${inputs}` : "";
				const mapped =
					value.kind === "record"
						? this.#record(value.name)
						: value.kind === "union"
							? this.#plan.unions.get(value.name)!
							: this.#plan.tagged.get(value.name)!;
				if (cRecordHasConstMembers(this.#model, mapped.record)) {
					if (!initializeRecord)
						throw new Error("const-record input must initialize a native value");
					const converted = this.#fresh("converted");
					const spelling =
						type.kind === "record" ? mapped.spelling : localDeclaration(type, "");
					return [
						`bool ${converted};`,
						`${spelling} ${target} = mal_ffi_construct_${value.name}(vm, ${source}, ${site}, &${converted}${retained});`,
						`if (!${converted}) ${fail}`,
					];
				}
				const helper =
					value.kind === "union"
						? `mal_ffi_union_in_${value.name}`
						: value.kind === "tagged"
							? `mal_ffi_tagged_in_${value.name}`
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
			case "array": {
				if (value.format !== undefined)
					return [
						`if (!mal_ffi_to_fixed_${value.format}(vm, ${source}, (void *) (${target}), ${value.length}, ${site})) ${fail}`,
					];
				const resolved = resolveCType(this.#model, type);
				if (resolved.kind !== "array")
					throw new Error("array mapping without an array type");
				const index = this.#fresh("index");
				const element = this.#fresh("element");
				const held = rooted ? source : this.#fresh("held");
				const roots = this.#fresh("roots");
				const failed = rooted ? fail : `{ mal_ffi_unroot(&${roots}); ${fail} }`;
				let converted: Array<string>;
				if (initializeRecord && value.of.kind !== "array") {
					const native = this.#fresh("native_element");
					const construct =
						(value.of.kind === "record" ||
							value.of.kind === "union" ||
							value.of.kind === "tagged" ||
							(value.of.kind === "handle" && value.of.pass === "copy")) &&
						this.#immutableRecord(resolved.of);
					const spelling =
						value.of.kind === "record"
							? this.#record(value.of.name).spelling
							: localDeclaration(resolved.of, "");
					converted = [
						...(construct ? [] : [`typeof_unqual(${spelling}) ${native};`]),
						...this.read(
							value.of,
							resolved.of,
							element,
							native,
							site,
							failed,
							strings,
							false,
							inputs,
							false,
							construct,
						),
						`__builtin_memcpy((void *) &(${target})[${index}], &${native}, sizeof(${native}));`,
					];
				} else
					converted = this.read(
						value.of,
						resolved.of,
						element,
						`${target}[${index}]`,
						site,
						failed,
						strings,
						false,
						inputs,
						false,
						initializeRecord,
					);
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
					...converted.map((line) => `\t${line}`),
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
			case "native":
				return `mal_ffi_native_out_${value.name}(vm, ${expression})`;
			case "callable":
				return `(${expression}) == nullptr ? mal_ffi_null() : mal_ffi_new_callable(vm, ${cString(value.site)}, ${value.signature.params.length}, mal_ffi_function_${value.name}, &(${expression}), sizeof(${expression}), ${value.owner === undefined ? "mal_ffi_undefined()" : owner})`;
			case "handle": {
				const created = (address: string) => {
					const loan = `mal_ffi_new_callback_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address})`;
					const ordinary =
						value.lifetime === "library"
							? `mal_ffi_new_library_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address})`
							: value.owner === undefined
								? `mal_ffi_new_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address}, ${value.owned}, ${value.fresh === true})`
								: `mal_ffi_new_owner_handle(vm, &mal_ffi_library, &mal_ffi_type_${value.name}, ${address}, ${owner})`;
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
				if (value.format === "string")
					return `mal_ffi_from_fixed_string(vm, ${expression}, ${value.length})`;
				if (value.format === "bytes")
					return `mal_ffi_from_bytes(vm, ${expression}, ${value.length})`;
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
			...(value.of.kind === "array"
				? this.#produceElement(
						value.of,
						`(${expression})[${index}]`,
						target,
						index,
						true,
					).map((line) => `\t\t${line}`)
				: [
						`\t\tmal_ffi_set_element(vm, ${target}, ${index}, ${this.write(value.of, `(${expression})[${index}]`, true)});`,
					]),
			"\t}",
			"}",
			"if (mal_ffi_threw(vm)) goto mal_done;",
		];
	}

	#produceElement(
		value: JsValue,
		expression: string,
		array: string,
		index: string,
		lent: boolean | string,
	): Array<string> {
		const element = this.#fresh("element");
		const roots = this.#fresh("roots");
		const stored = this.#fresh("stored");
		return [
			`MalValue ${element} = mal_ffi_undefined();`,
			`MalFfiRoots ${roots};`,
			`mal_ffi_root(&${roots}, &${element}, 1);`,
			...this.#produce(value, expression, element, lent).map((line) =>
				line.replaceAll(
					"goto mal_done;",
					`{ mal_ffi_unroot(&${roots}); goto mal_done; }`,
				),
			),
			`bool ${stored} = mal_ffi_set_element(vm, ${array}, ${index}, ${element});`,
			`mal_ffi_unroot(&${roots});`,
			`if (!${stored}) goto mal_done;`,
		];
	}

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
		if (value.kind !== "array" || value.format !== undefined) {
			return [
				`${target} = ${this.write(value, expression, lent)};`,
				...(this.#allocates(value) ? ["if (mal_ffi_threw(vm)) goto mal_done;"] : []),
			];
		}
		const index = this.#fresh("index");
		return [
			`${target} = mal_ffi_new_array(vm, ${value.length});`,
			"if (mal_ffi_threw(vm)) goto mal_done;",
			`for (int32_t ${index} = 0; ${index} < ${value.length}; ${index}++) {`,
			...this.#produceElement(
				value.of,
				`${expression}[${index}]`,
				target,
				index,
				lent,
			).map((line) => `\t${line}`),
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
			if (cRecordHasConstMembers(this.#model, this.#record(name).record)) return;
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
			`static bool mal_ffi_leaves_${name}(MalVm *vm, const MalValue **mal_leaves, const MalFfiSite *mal_site, typeof_unqual(${record.spelling}) *mal_out) {`,
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
		if (cRecordHasConstMembers(this.#model, record.record))
			return this.#recordConstructor(name);
		const retained = this.#hasHandles({ kind: "record", name });
		const parameter = retained ? ", MalFfiInputs *mal_inputs" : "";
		const count = String(record.fields.length);
		const lines = [
			"",
			`static bool mal_ffi_fields_${name}(MalVm *vm, const MalValue *mal_fields, const MalFfiSite *mal_site, typeof_unqual(${record.spelling}) *mal_out${parameter}) {`,
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
			`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, typeof_unqual(${record.spelling}) *mal_out${parameter}) {`,
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

	#initializerRoots(value: JsValue): number {
		return value.kind === "array"
			? value.length * (1 + this.#initializerRoots(value.of))
			: 0;
	}

	#initializer(
		value: JsValue,
		type: CType,
		source: string,
		context: {
			lines: Array<string>;
			roots: string;
			nextRoot: number;
			site: string;
			fail: string;
			inputs: string;
		},
	): string {
		if (value.kind === "array") {
			const resolved = resolveCType(this.#model, type);
			if (resolved.kind !== "array")
				throw new Error("array initializer without array type");
			const elements: Array<string> = [];
			for (let index = 0; index < value.length; index++) {
				const element = `${context.roots}[${context.nextRoot++}]`;
				context.lines.push(
					`\tif (!mal_ffi_element(vm, ${source}, ${index}, ${value.length}, ${context.site}, &${element})) ${context.fail}`,
				);
				elements.push(this.#initializer(value.of, resolved.of, element, context));
			}
			return `{ ${elements.join(", ")} }`;
		}
		const local = this.#fresh("field");
		const aggregate =
			value.kind === "record"
				? this.#record(value.name)
				: value.kind === "union"
					? this.#plan.unions.get(value.name)
					: value.kind === "tagged"
						? this.#plan.tagged.get(value.name)
						: undefined;
		const spelling = aggregate?.spelling ?? localDeclaration(type, "");
		const initialize =
			aggregate !== undefined && cRecordHasConstMembers(this.#model, aggregate.record);
		if (!initialize) context.lines.push(`\ttypeof_unqual(${spelling}) ${local};`);
		context.lines.push(
			...this.read(
				value,
				type,
				source,
				local,
				context.site,
				context.fail,
				[],
				false,
				context.inputs,
				false,
				initialize,
			).map((line) => `\t${line}`),
		);
		return local;
	}

	#recordConstructor(name: string): Array<string> {
		const record = this.#record(name);
		const retained = this.#hasHandles({ kind: "record", name });
		const count =
			record.fields.length +
			1 +
			record.fields.reduce(
				(total, field) => total + this.#initializerRoots(field.value),
				0,
			);
		const lines = [
			"",
			`static ${record.spelling} mal_ffi_construct_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, bool *mal_ok${retained ? ", MalFfiInputs *mal_inputs" : ""}) {`,
			`\tMalValue mal_fields[${count}] = { mal_value };`,
			"\tMalFfiRoots mal_roots;",
			`\tmal_ffi_root(&mal_roots, mal_fields, ${count});`,
			`\tif (!mal_ffi_record_fields(vm, mal_fields[0], &mal_ffi_record_${name}, mal_site, mal_fields + 1)) goto mal_failed;`,
			"\tMalFfiSite mal_field_site = *mal_site;",
		];
		const context = {
			lines,
			roots: "mal_fields",
			nextRoot: record.fields.length + 1,
			site: "&mal_field_site",
			fail: "goto mal_failed;",
			inputs: retained ? "mal_inputs" : "nullptr",
		};
		// C does not evaluate initializer expressions in field order, so convert first.
		const fields = record.fields.map((field, index) => {
			lines.push(`\tmal_field_site.field = ${cString(field.name)};`);
			return `.${field.name} = ${this.#initializer(field.value, field.type, `mal_fields[${index + 1}]`, context)}`;
		});
		const tag = this.#taggedCaseInitializers.get(name);
		if (tag !== undefined) fields.unshift(tag);
		lines.push(
			"\tmal_ffi_unroot(&mal_roots);",
			"\t*mal_ok = true;",
			`\treturn (${record.spelling}) { ${fields.join(", ")} };`,
			"mal_failed:",
			"\tmal_ffi_unroot(&mal_roots);",
			"\t*mal_ok = false;",
			`\treturn (${record.spelling}) {};`,
			"}",
		);
		return lines;
	}

	#unionConstructor(name: string): Array<string> {
		const union = this.#plan.unions.get(name)!;
		const retained = this.#hasHandles(union.member.value);
		const count = 1 + this.#initializerRoots(union.member.value);
		const lines = [
			`static ${union.spelling} mal_ffi_construct_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, bool *mal_ok${retained ? ", MalFfiInputs *mal_inputs" : ""}) {`,
			`\tMalValue mal_fields[${count}] = { mal_value };`,
			"\tMalFfiRoots mal_roots;",
			`\tmal_ffi_root(&mal_roots, mal_fields, ${count});`,
		];
		const initializer = this.#initializer(
			union.member.value,
			union.member.type,
			"mal_fields[0]",
			{
				lines,
				roots: "mal_fields",
				nextRoot: 1,
				site: "mal_site",
				fail: "goto mal_failed;",
				inputs: retained ? "mal_inputs" : "nullptr",
			},
		);
		lines.push(
			"\tmal_ffi_unroot(&mal_roots);",
			"\t*mal_ok = true;",
			`\treturn (${union.spelling}) { .${union.member.name} = ${initializer} };`,
			"mal_failed:",
			"\tmal_ffi_unroot(&mal_roots);",
			"\t*mal_ok = false;",
			`\treturn (${union.spelling}) {};`,
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
			if (cRecordHasConstMembers(this.#model, record.record))
				lines.push(
					`static ${record.spelling} mal_ffi_construct_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, bool *mal_ok${retained});`,
				);
			else
				lines.push(
					`static bool mal_ffi_fields_${name}(MalVm *vm, const MalValue *mal_fields, const MalFfiSite *mal_site, typeof_unqual(${record.spelling}) *mal_out${retained});`,
					`static bool mal_ffi_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, typeof_unqual(${record.spelling}) *mal_out${retained});`,
				);
		}
		for (const name of leaves) {
			lines.push(
				`static bool mal_ffi_leaves_${name}(MalVm *vm, const MalValue **mal_leaves, const MalFfiSite *mal_site, typeof_unqual(${this.#record(name).spelling}) *mal_out);`,
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
				cRecordHasConstMembers(this.#model, union.record)
					? `static ${union.spelling} mal_ffi_construct_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, bool *mal_ok${retained});`
					: `static bool mal_ffi_union_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${union.spelling} *mal_out${retained});`,
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
			if (cRecordHasConstMembers(this.#model, union.record)) {
				lines.push(...this.#unionConstructor(name));
				continue;
			}
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

	#taggedConstructor(name: string, signature: string): Array<string> {
		const tagged = this.#plan.tagged.get(name)!;
		const lines = [
			`${signature} {`,
			"MalValue mal_values[2] = { mal_value };",
			"MalFfiRoots mal_roots;",
			"mal_ffi_root(&mal_roots, mal_values, 2);",
			`${localDeclaration(tagged.tag.type, "mal_tag")} = {};`,
			`if (!mal_ffi_record_fields(vm, mal_values[0], &mal_ffi_tag_type_${name}, mal_site, mal_values + 1)) goto mal_failed;`,
			...this.read(
				tagged.tag.value,
				tagged.tag.type,
				"mal_values[1]",
				"mal_tag",
				"mal_site",
				"goto mal_failed;",
				[],
				true,
			),
			"switch (mal_tag) {",
		];
		for (const entry of tagged.cases) {
			const retained = this.#hasHandles({ kind: "record", name: entry.record.name });
			lines.push(
				`case ${entry.expression}: {`,
				"bool mal_converted;",
				`${tagged.spelling} mal_native = mal_ffi_construct_${entry.record.name}(vm, mal_values[0], mal_site, &mal_converted${retained ? ", mal_inputs" : ""});`,
				"if (!mal_converted) goto mal_failed;",
				`if (mal_native.${tagged.tag.name} != mal_tag) { mal_ffi_expected(vm, mal_site, "a payload preserving its discriminator"); goto mal_failed; }`,
				"mal_ffi_unroot(&mal_roots);",
				"*mal_ok = true;",
				"return mal_native;",
				"}",
			);
		}
		lines.push(
			'default: mal_ffi_expected(vm, mal_site, "a known union discriminator"); break;',
			"}",
			"mal_failed:",
			"mal_ffi_unroot(&mal_roots);",
			"*mal_ok = false;",
			`return (${tagged.spelling}) {};`,
			"}",
		);
		return lines;
	}

	#taggedHelpers(declarations: boolean): Array<string> {
		const lines: Array<string> = [];
		for (const name of new Set([...this.#taggedInputs, ...this.#taggedOutputs])) {
			const tagged = this.#plan.tagged.get(name)!;
			const retained = tagged.cases.some((entry) =>
				this.#hasHandles({ kind: "record", name: entry.record.name }),
			);
			const immutable = cRecordHasConstMembers(this.#model, tagged.record);
			const input = immutable
				? `static ${tagged.spelling} mal_ffi_construct_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, bool *mal_ok${retained ? ", MalFfiInputs *mal_inputs" : ""})`
				: `static bool mal_ffi_tagged_in_${name}(MalVm *vm, MalValue mal_value, const MalFfiSite *mal_site, ${tagged.spelling} *mal_out${retained ? ", MalFfiInputs *mal_inputs" : ""})`;
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
				);
				if (immutable) lines.push(...this.#taggedConstructor(name, input));
				else {
					lines.push(
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

	nativeTypes(): Array<string> {
		return [...this.#plan.natives.values()].flatMap(({ name }) => [
			`static const MalFfiHandleType mal_ffi_type_${name} = { .name = ${cString(name)}, .size = sizeof(${name}), .alignment = _Alignof(${name}) };`,
			`static MalValue mal_ffi_native_out_${name}(MalVm *vm, ${name} mal_value) { typeof_unqual(${name}) mal_copy = mal_value; return mal_ffi_new_handle(vm, &mal_ffi_library, &mal_ffi_type_${name}, &mal_copy, false, false); }`,
			`static MalValue mal_ffi_native_zero_${name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
			"\t(void) mal_this; (void) mal_args; (void) mal_argc; (void) mal_new_target; (void) mal_callee;",
			`\t${name} mal_zero = {};`,
			`\treturn mal_ffi_native_out_${name}(vm, mal_zero);`,
			"}",
		]);
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
					: handle.fields.filter(
							(field) => field.value.kind !== "callable" && field.value.kind !== "handle",
						);
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
					...(this.#libraryFamilies.has(handle.family)
						? [
								`\tif (mal_ffi_is_library_resource(&mal_ffi_type_${name}, mal_value)) return false;`,
							]
						: []),
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
					...(field.value.kind === "handle" && field.value.owner !== undefined
						? [
								"\tif (!mal_ffi_owner_ready(vm, mal_this, &mal_site)) return mal_ffi_undefined();",
							]
						: []),
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
				`\t${this.#ownerFamilies.has(handle.family)},`,
				`\t${this.#libraryFamilies.has(handle.family)},`,
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
					...(handle.layout !== undefined
						? [
								`\tstatic const MalFfiSite mal_site = { ${cString(handle.allocator)}, "layout", nullptr };`,
								...(this.#plan.hasCallbacks ? ["\tmal_ffi_collectable_begin(vm);"] : []),
								`\tuint64_t mal_size = ${handle.layout.size}();`,
								...(this.#plan.hasCallbacks ? ["\tmal_ffi_collectable_end(vm);"] : []),
								"\tif (mal_ffi_threw(vm)) return mal_ffi_undefined();",
								...(this.#plan.hasCallbacks ? ["\tmal_ffi_collectable_begin(vm);"] : []),
								`\tuint64_t mal_alignment = ${handle.layout.alignment}();`,
								...(this.#plan.hasCallbacks ? ["\tmal_ffi_collectable_end(vm);"] : []),
								"\tif (mal_ffi_threw(vm)) return mal_ffi_undefined();",
								`\treturn mal_ffi_allocate_opaque_handle(vm, &mal_ffi_library, &mal_ffi_type_${name}, mal_size, mal_alignment, &mal_site);`,
							]
						: handle.trailing === undefined
							? [
									`\treturn mal_ffi_allocate_handle(vm, &mal_ffi_library, &mal_ffi_type_${name}, sizeof(${handle.spelling}), _Alignof(${handle.spelling}));`,
								]
							: [
									`\tstatic const MalFfiSite mal_site = { ${cString(handle.allocator)}, "length", nullptr };`,
									`\tstatic_assert(sizeof(((${handle.spelling} *) nullptr)->${handle.trailing}[0]) > 0, "FFI trailing elements need nonzero size");`,
									"\tuint64_t mal_count;",
									"\tif (!mal_ffi_to_uint64(vm, mal_argc > 0 ? mal_args[0] : mal_ffi_undefined(), 64, &mal_site, &mal_count)) return mal_ffi_undefined();",
									`\treturn mal_ffi_allocate_trailing_handle(vm, &mal_ffi_library, &mal_ffi_type_${name}, mal_count, offsetof(${handle.spelling}, ${handle.trailing}), sizeof(((${handle.spelling} *) nullptr)->${handle.trailing}[0]), sizeof(${handle.spelling}), _Alignof(${handle.spelling}), &mal_site);`,
								]),
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

	#callerArray(
		binding: BoundFunction,
		entry: Extract<Argument, { kind: "out" | "inout" }>,
		index: number,
		context: string,
		source: string | undefined,
		site: string,
		fail: string,
	): {
		declarations: Array<string>;
		lengthLines: Array<string>;
		lines: Array<string>;
		length: string;
		cleanup: string;
	} {
		const output = binding.outputs[entry.output]!;
		const value = output.value;
		if (value.kind !== "sequence") throw new Error("caller array without a sequence");
		const name = `mal_output_${entry.output}`;
		const buffer = `${context}${name}`;
		const bound = `mal_capacity_${entry.output}`;
		const length = `${context}${bound}`;
		const lines: Array<string> = [];
		if (source !== undefined)
			lines.push(
				`if (!mal_ffi_to_array_length(vm, ${source}, false, ${site}, &${length})) ${fail}`,
			);
		else {
			if (typeof output.capacity !== "number")
				throw new Error("out array without an integer capacity");
			const capacity = `${context}mal_argument_${output.capacity}`;
			lines.push(
				`if (!mal_ffi_check_array_count(vm, (uint64_t) ${capacity}, INT32_MAX, ${site})) ${fail}`,
				`${length} = (int32_t) ${capacity};`,
			);
		}
		const lengthLines = lines.splice(0);
		lines.push(
			`static_assert(sizeof(*${buffer}) > 0 && sizeof(*${buffer}) % _Alignof(__typeof__(*${buffer})) == 0, "FFI array stride must preserve C alignment");`,
			`if (${length} > 0) {`,
			`\t${buffer} = mal_ffi_calloc_storage((size_t) ${length}, sizeof(*${buffer}), _Alignof(__typeof__(*${buffer})));`,
			`\tif (${buffer} == nullptr) { mal_ffi_out_of_memory(vm); ${fail} }`,
			"}",
			`${context}mal_argument_${index} = ${buffer};`,
		);
		if (source !== undefined) {
			const position = this.#fresh("index");
			const element = this.#fresh("element");
			const native = this.#fresh("native_element");
			const construct = value.of.kind !== "array" && this.#immutableRecord(value.element);
			lines.push(
				`for (int32_t ${position} = 0; ${position} < ${length}; ${position}++) {`,
				`\tMalValue ${element};`,
				`\tif (!mal_ffi_element(vm, ${source}, ${position}, ${length}, ${site}, &${element})) ${fail}`,
				...this.read(
					value.of,
					value.element,
					element,
					construct ? native : `${buffer}[${position}]`,
					site,
					fail,
					[],
					false,
					"nullptr",
					false,
					construct || value.of.kind === "array",
				).map((line) => `\t${line}`),
				...(construct
					? [
							`\t__builtin_memcpy((void *) &${buffer}[${position}], &${native}, sizeof(${native}));`,
						]
					: []),
				"}",
			);
		}
		return {
			declarations: [
				`${localDeclaration(output.type, name)}${context === "" ? " = nullptr" : ""};`,
				`int32_t ${bound}${context === "" ? " = 0" : ""};`,
			],
			lengthLines,
			lines,
			length,
			cleanup: `free((void *) ${buffer});`,
		};
	}

	#output(
		binding: BoundFunction,
		index: number,
		expression: string,
		target: string,
		context: string,
		results?: string,
	): Array<string> {
		const output = binding.outputs[index]!;
		const count = countValue(binding, output.count, context);
		const owned = this.#owned(
			output.value,
			expression,
			target,
			count,
			"&mal_site_result",
			true,
			`&${context}mal_discards`,
			results,
		);
		if (output.capacity === undefined) return owned;
		if (count === undefined) throw new Error("caller array without a written count");
		return [
			`if (!mal_ffi_threw(vm) && mal_ffi_check_array_count(vm, (uint64_t) (${count}), ${context}mal_capacity_${index}, &mal_site_result)) {`,
			`\tif (${expression} == nullptr) ${target} = mal_ffi_new_array(vm, 0);`,
			"\telse {",
			...owned.map((line) => `\t\t${line}`),
			"\t}",
			"}",
		];
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
		discards: string,
		results?: string,
	): Array<string> {
		const release =
			"free" in value && value.free !== undefined
				? [`if ((${expression}) != nullptr) ${value.free}((void *) (${expression}));`]
				: [];
		// A result that allocates nothing is simply ignored when a throw is pending.
		const unlessThrew =
			pending && this.#allocates(value) ? "if (!mal_ffi_threw(vm)) " : "";
		if (results !== undefined && value.kind === "handle")
			return [
				`if (!mal_ffi_threw(vm)) ${target} = mal_ffi_result_handle(vm, ${results}, &mal_ffi_library, &mal_ffi_type_${value.name}, (void *) (${expression}), ${value.owned}, ${value.fresh === true});`,
			];
		const handle =
			value.kind === "handle" && value.owned ? this.#handle(value.name) : undefined;
		if (
			value.kind === "handle" &&
			handle?.representation === "pointer" &&
			handle.destroy !== undefined
		) {
			const claim = `mal_ffi_discard_claim(vm, ${discards}, &mal_ffi_type_${handle.name}, (void *) (${expression}), ${value.fresh === true})`;
			if (!pending)
				return [`${claim};`, `${target} = ${this.write(value, expression)};`, ...release];
			const destroy = this.#fresh("discard");
			return [
				`bool ${destroy} = ${claim};`,
				`if (!mal_ffi_threw(vm)) ${target} = ${this.write(value, expression)};`,
				`else if (${destroy}) mal_ffi_destroy_${handle.name}((void *) (${expression}));`,
				...release,
			];
		}
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
		if (value.kind === "array") {
			const done = this.#fresh("array_done");
			// The caller must retire its output root span even when an element throws.
			return [
				"if (!mal_ffi_threw(vm)) {",
				...this.#produce(value, expression, target).map(
					(line) => `\t${line.replaceAll("goto mal_done;", `goto ${done};`)}`,
				),
				`${done}:;`,
				"}",
				...release,
			];
		}
		if (value.kind === "sequence") {
			const array = this.#fresh("array");
			const roots = this.#fresh("roots");
			const index = this.#fresh("index");
			const done = this.#fresh("sequence_done");
			return [
				"if (!mal_ffi_threw(vm)) {",
				`\tif ((${expression}) == nullptr) ${target} = mal_ffi_null();`,
				`\telse if (mal_ffi_check_count(vm, (size_t) (${count}), 32, true, ${site})) {`,
				`\t\tMalValue ${array} = mal_ffi_new_array(vm, (int32_t) (${count}));`,
				`\t\tMalFfiRoots ${roots};`,
				`\t\tmal_ffi_root(&${roots}, &${array}, 1);`,
				`\t\tfor (int32_t ${index} = 0; !mal_ffi_threw(vm) && ${index} < (int32_t) (${count}); ${index}++) {`,
				...(value.of.kind === "array"
					? this.#produceElement(
							value.of,
							`(${expression})[${index}]`,
							array,
							index,
							false,
						).map((line) => `\t\t\t${line.replaceAll("goto mal_done;", `goto ${done};`)}`)
					: [
							`\t\t\tmal_ffi_set_element(vm, ${array}, ${index}, ${this.write(value.of, `(${expression})[${index}]`)});`,
						]),
				"\t\t}",
				...(value.of.kind === "array" ? [`${done}:;`] : []),
				`\t\tmal_ffi_unroot(&${roots});`,
				`\t\t${target} = ${array};`,
				"\t}",
				"}",
				...release,
			];
		}
		return [`${unlessThrew}${target} = ${this.write(value, expression)};`, ...release];
	}

	// Zero the selected union member so C reads an initialized representation.
	#callbackDefault(value: JsValue): string {
		if (value.kind === "union") {
			const union = this.#plan.unions.get(value.name)!;
			return `{ .${union.member.name} = ${this.#callbackDefault(union.member.value)} }`;
		}
		if (value.kind === "array")
			return `{ ${Array.from({ length: value.length }, () => this.#callbackDefault(value.of)).join(", ")} }`;
		if (value.kind === "record")
			return `{ ${this.#record(value.name)
				.fields.map((field) => `.${field.name} = ${this.#callbackDefault(field.value)}`)
				.join(", ")} }`;
		if (value.kind === "tagged") {
			const tagged = this.#plan.tagged.get(value.name)!;
			const zero = tagged.cases.find((entry) =>
				["0", "0n", "false"].includes(entry.literal),
			);
			if (zero !== undefined)
				return `{ ${[...(zero.initializeTag ? [`.${tagged.tag.name} = 0`] : []), ...zero.record.fields.map((field) => `.${field.name} = ${this.#callbackDefault(field.value)}`)].join(", ")} }`;
		}
		return "{}";
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
		const immutableReturn = this.#immutableRecord(type.returns);
		const zero = `(${localDeclaration(type.returns, "")}) ${immutableReturn ? this.#callbackDefault(value.returns) : "{}"}`;
		const emptyReturn = immutableReturn ? zero : "mal_return";
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
					"nullptr",
					false,
					immutableReturn,
				),
				...(immutableReturn ? ["mal_return_ready = true;"] : []),
			);
		const lines = [
			"",
			`static ${formatCDeclaration(type.returns, `${body}(${signature.length === 0 ? "void" : signature.join(", ")})`)} {`,
			...(queued ? [] : [`\tMalFfiCallback *mal_callback = ${callback};`]),
			...(immutableReturn
				? ["\tbool mal_return_ready = false;"]
				: returns
					? [`\t${localDeclaration(type.returns, "mal_return")} = {};`]
					: []),
			...(value.resultCount === undefined
				? []
				: [
						`\tif (mal_c${String(value.resultCount.param)} != nullptr) *mal_c${String(value.resultCount.param)} = 0;`,
					]),
			...(scoped
				? ["\tif (mal_callback == nullptr) mal_ffi_callback_lost();"]
				: data < 0 || value.closes !== undefined
					? [`\tif (mal_callback == nullptr) return${returns ? ` ${emptyReturn}` : ""};`]
					: []),
			...(value.kept
				? [
						...(keyedLookup && !queued ? [] : ["\tmal_ffi_callback_hold(mal_callback);"]),
						"\tMalVm *vm = mal_ffi_callback_vm(mal_callback);",
						// A library may call back after the VM is gone; it gets a zero result.
						`\tif (vm == nullptr) { mal_ffi_callback_drop(mal_callback); return${returns ? ` ${emptyReturn}` : ""}; }`,
					]
				: [
						"\tMalVm *vm = mal_ffi_callback_vm(mal_callback);",
						`\tif (vm == nullptr) return${returns ? ` ${emptyReturn}` : ""};`,
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
						immutableReturn
							? "\tif (mal_ffi_threw(vm)) mal_return_ready = false;"
							: `\tif (mal_ffi_threw(vm)) mal_return = ${zero};`,
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
			returns
				? immutableReturn
					? `\treturn mal_return_ready ? mal_return : ${zero};`
					: "\treturn mal_return;"
				: "\treturn;",
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
		const immutableReturn = this.#immutableRecord(type.returns);
		const layout = `${message}_Layout`;
		const zero = `(${localDeclaration(type.returns, "")}) ${immutableReturn ? this.#callbackDefault(value.returns) : "{}"}`;
		const run = `${name}_run(${["mal_callback", ...type.params.map((_, index) => `mal_message->mal_c${String(index)}`)].join(", ")})`;
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
				(param.kind === "string" || param.kind === "bytes" || param.kind === "sequence")
			);
		};
		const checkedCopies =
			!waiting &&
			value.params.some(
				(param) =>
					typeof param === "object" &&
					(param.kind === "bytes" ||
						param.kind === "sequence" ||
						(param.kind === "string" && param.counted)),
			);
		const initialized = new Set(
			type.params.flatMap((type, index) => (this.#immutableRecord(type) ? [index] : [])),
		);
		const copies = type.params.flatMap((_, index) => {
			if (initialized.has(index)) return [];
			const param = value.params[index];
			const field = `mal_message->mal_c${String(index)}`;
			const source = `mal_c${String(index)}`;
			if (
				waiting ||
				typeof param !== "object" ||
				(param.kind !== "string" && param.kind !== "bytes" && param.kind !== "sequence")
			) {
				return [`${field} = ${source};`];
			}
			if (param.kind === "bytes" || param.kind === "sequence" || param.counted) {
				const copy = `mal_copy_${String(index)}`;
				const status = `mal_copy_status_${String(index)}`;
				const count = `(uint64_t) mal_c${String(value.counts[index]!)}`;
				let leaf = param.kind === "sequence" ? param.of : param;
				while (leaf.kind === "array") leaf = leaf.of;
				const arrayCopy =
					leaf.kind === "string"
						? "mal_ffi_copy_callback_strings"
						: "mal_ffi_copy_callback_array";
				const call =
					param.kind === "sequence"
						? `${arrayCopy}(${source}, ${count}, sizeof(*${source}), _Alignof(__typeof__(*${source})), &${copy})`
						: `mal_ffi_copy_callback_bytes(${source}, ${count}, ${param.kind === "string"}, &${copy})`;
				return [
					`void *${copy};`,
					`MalFfiCopyStatus ${status} = ${call};`,
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
			...(returns
				? [
						`\t${immutableReturn ? "void *mal_return" : localDeclaration(type.returns, "mal_return")};`,
					]
				: []),
			// Locals' declarations drop a top-level `const`, which the copies assign.
			...type.params.map(
				(param, index) => `\t${localDeclaration(param, `mal_c${String(index)}`)};`,
			),
			...(type.params.length === 0 ? ["\tchar mal_unused;"] : []),
			`} ${message};`,
			// The layout supplies offsets only: initializing it would also initialize const result storage.
			...(immutableReturn
				? [
						`typedef struct ${layout} { ${message} header; ${localDeclaration(type.returns, "result")}; } ${layout};`,
					]
				: []),
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
			...(immutableReturn
				? [
						`\t${localDeclaration(type.returns, "mal_native")} = ${run};`,
						"\t__builtin_memcpy(mal_message->mal_return, &mal_native, sizeof(mal_native));",
					]
				: [`\t${returns ? "mal_message->mal_return = " : ""}${run};`]),
			"}",
			"",
			`static ${formatCDeclaration(type.returns, `${name}(${params.length === 0 ? "void" : params.join(", ")})`)} {`,
			...(!immutableReturn && returns
				? [`\t${localDeclaration(type.returns, "mal_return")} = {};`]
				: []),
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
			`\t\t${message} *mal_message = mal_ffi_allocate_storage(1, sizeof(${immutableReturn ? layout : message}), _Alignof(${immutableReturn ? layout : message}));`,
			"\t\tif (mal_message != nullptr) {",
			...(initialized.size === 0
				? []
				: [
						`\t\t\t__builtin_memcpy(mal_message, &(${message}) { ${[...initialized].map((index) => `.mal_c${String(index)} = mal_c${String(index)}`).join(", ")} }, sizeof(*mal_message));`,
					]),
			...(immutableReturn
				? [
						`\t\t\tmal_message->mal_return = (unsigned char *) mal_message + offsetof(${layout}, result);`,
					]
				: []),
			"\t\t\tbool mal_ok = true;",
			...(checkedCopies ? ["\t\t\tmal_message->mal_copy_error = MAL_FFI_COPY_OK;"] : []),
			...copies.map((line) => `\t\t\t${line}`),
			"\t\t\tif (!mal_ok) {",
			`\t\t\t\t${name}_free(mal_message);`,
			"\t\t\t\tmal_message = nullptr;",
			"\t\t\t}",
			"\t\t}",
			...(waiting
				? [
						"\t\tMalFfiWait *mal_request;",
						`\t\t${returns ? "bool mal_succeeded = " : ""}mal_ffi_callback_wait(mal_callback, ${name}_queued, mal_message, ${name}_free, &mal_request);`,
						...(returns
							? [
									immutableReturn
										? `\t\t${localDeclaration(type.returns, "mal_return")} = mal_succeeded ? *(${localDeclaration(type.returns, "*")}) mal_message->mal_return : ${zero};`
										: "\t\tif (mal_succeeded) mal_return = mal_message->mal_return;",
								]
							: []),
						"\t\tmal_ffi_callback_wait_release(mal_request);",
					]
				: [
						`\t\tmal_ffi_callback_queue(mal_callback, ${name}_queued, mal_message, ${name}_free);`,
					]),
			...(value.closes === undefined ? [] : ["\t\tmal_ffi_close_return(mal_callback);"]),
			...(keyedLookup ? ["\t\tmal_ffi_callback_drop(mal_callback);"] : []),
			...(waiting ? ["\t\tmal_ffi_callback_wait_leave(mal_cancellation);"] : []),
			`\t\treturn${returns ? " mal_return" : ""};`,
			"\t}",
			`\t${returns ? `${immutableReturn ? localDeclaration(type.returns, "mal_return") : "mal_return"} = ` : ""}${name}_run(${["mal_callback", ...args].join(", ")});`,
			...(value.closes === undefined ? [] : ["\tmal_ffi_close_return(mal_callback);"]),
			...(keyedLookup
				? ["\tif (mal_callback != nullptr) mal_ffi_callback_drop(mal_callback);"]
				: []),
			...(waiting ? ["\tmal_ffi_callback_wait_leave(mal_cancellation);"] : []),
			...(returns ? ["\treturn mal_return;"] : []),
			"}",
		];
	}

	#discardCount(binding: BoundFunction): number {
		return [binding.returns, ...binding.outputs.map((output) => output.value)].filter(
			(value) =>
				value.kind === "handle" &&
				value.owned &&
				this.#handle(value.name).representation === "pointer" &&
				this.#handle(value.name).destroy !== undefined,
		).length;
	}

	#transactionalResults(binding: BoundFunction): boolean {
		const safe = (value: JsValue, nested = false): boolean => {
			switch (value.kind) {
				case "handle":
					return (
						!nested &&
						value.owner === undefined &&
						value.lifetime === undefined &&
						this.#handle(value.name).representation === "pointer"
					);
				case "callable":
					return false;
				case "array":
				case "sequence":
				case "union":
					return safe(value.of, true);
				case "tagged":
					return value.cases.every((entry) => safe(entry.value, true));
				case "record":
					return this.#record(value.name).fields.every((field) =>
						safe(field.value, true),
					);
				default:
					return true;
			}
		};
		return (
			this.#discardCount(binding) > 0 &&
			[binding.returns, ...binding.outputs.map((output) => output.value)].every((value) =>
				safe(value),
			)
		);
	}

	#resultClaims(
		binding: BoundFunction,
		result: string,
		output: (index: number) => string,
	): Array<string> {
		return [
			{ value: binding.returns, expression: result },
			...binding.outputs.map((entry, index) => ({
				value: entry.value,
				expression: output(index),
			})),
		].flatMap(({ value, expression }) =>
			value.kind === "handle" &&
			value.owned &&
			this.#handle(value.name).destroy !== undefined
				? [
						`mal_ffi_result_claim(vm, &mal_results, &mal_ffi_type_${value.name}, (void *) (${expression}), ${value.fresh === true});`,
					]
				: [],
		);
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
		if (binding.global?.retained !== undefined) {
			const global = `mal_ffi_global_${binding.global.declaration.name}`;
			const set = binding.global.access === "set";
			return [
				`static inline MalValue mal_ffi_call_${name}(MalVm *vm, const MalValue *mal_args, int32_t mal_argc, bool mal_framed) {`,
				"\t(void) mal_args; (void) mal_argc; (void) mal_framed;",
				`\tstatic const MalFfiSite mal_site = { ${cString(name)}, ${set ? '"value"' : '"result"'}, nullptr };`,
				...(set
					? [
							`\tmal_ffi_set_global_value(vm, &${global}, mal_argc > 0 ? mal_args[0] : mal_ffi_undefined(), &mal_site);`,
							"\treturn mal_ffi_undefined();",
						]
					: [`\treturn mal_ffi_get_global_value(vm, &${global}, &mal_site);`]),
				"}",
				`static MalValue mal_ffi_function_${name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
				"\t(void) mal_this; (void) mal_new_target; (void) mal_callee;",
				`\treturn mal_ffi_call_${name}(vm, mal_args, mal_argc, true);`,
				"}",
			];
		}
		const siteName = callable?.site ?? name;
		const owner = callable?.owner;
		const declaration = binding.declaration;
		const constArguments = this.#constArguments(binding);
		const constOutputs = this.#constOutputs(binding);
		const outputValue = (index: number): string =>
			constOutputs.has(index) ? `(*mal_output_${index})` : `mal_output_${index}`;
		const locals: Array<string> = [];
		const discardCount = this.#discardCount(binding);
		const transactional = this.#transactionalResults(binding);
		const results = transactional ? "&mal_results" : undefined;
		if (discardCount > 0 && !transactional)
			locals.push(
				`MalFfiDiscardedHandle mal_discarded[${discardCount}];`,
				`MalFfiDiscards mal_discards = { .items = mal_discarded, .capacity = ${discardCount} };`,
			);
		if (transactional)
			locals.push(
				`MalFfiResultClaim mal_result_claims[${discardCount}];`,
				`MalValue mal_result_handles[${2 * discardCount}];`,
				"MalFfiResults mal_results;",
			);
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
				(entry) => entry.kind === "count" && entry.of.includes(counted),
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
				...(entry?.kind === "count" && entry.of.length > 1
					? [
							`if (mal_count_set_${target.index} && (uint64_t) mal_argument_${target.index} != (uint64_t) (${count})) { mal_ffi_expected(vm, ${site}, "a length matching the other arguments sharing this count"); goto mal_done; }`,
							`mal_count_set_${target.index} = true;`,
						]
					: []),
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
					`${local} = mal_ffi_allocate_storage(1, sizeof(${storage}), _Alignof(${storage}));`,
					`if (${local} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
				);
				cleanup.push(`free(${local});`);
			} else if (!constArguments.has(index))
				locals.push(`${localDeclaration(param.type, local)};`);
			const pointee = resolved.kind === "pointer" ? resolved.to : param.type;
			switch (entry.kind) {
				case "count":
					if (entry.of.length > 1) locals.push(`bool mal_count_set_${index} = false;`);
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
					if (binding.outputs[entry.output]!.capacity !== undefined) {
						const site =
							entry.kind === "inout" ? `&mal_site_${entry.param}` : "&mal_site_result";
						const prepared = this.#callerArray(
							binding,
							entry,
							index,
							"",
							entry.kind === "inout" ? argument(entry.param) : undefined,
							site,
							"goto mal_done;",
						);
						locals.push(...prepared.declarations);
						const into = entry.kind === "inout" ? body : buffers;
						into.push(...prepared.lengthLines);
						if (entry.kind === "inout") setCount(index, prepared.length, site, into);
						into.push(...prepared.lines);
						cleanup.push(prepared.cleanup);
						return;
					}

					if (constOutputs.has(entry.output)) {
						locals.push(
							`typeof_unqual(${localDeclaration(pointee, "")}) *${output} = nullptr;`,
						);
						const native = this.#fresh("native_output");
						const input =
							entry.kind === "inout" ? binding.params[entry.param]!.value : undefined;
						if (entry.kind === "inout" && input?.kind !== "array")
							body.push(
								...this.read(
									binding.params[entry.param]!.value,
									pointee,
									argument(entry.param),
									native,
									`&mal_site_${entry.param}`,
									"goto mal_done;",
									strings,
									true,
									inputs,
									false,
									true,
								),
							);
						body.push(
							`${output} = mal_ffi_allocate_storage(1, sizeof(*${output}), _Alignof(__typeof__(*${output})));`,
							`if (${output} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
							...(entry.kind === "inout" && input?.kind !== "array"
								? [`__builtin_memcpy(${output}, &${native}, sizeof(${native}));`]
								: []),
							`${local} = ${output};`,
						);
						if (entry.kind === "inout" && input?.kind === "array")
							body.push(
								...this.read(
									input,
									pointee,
									argument(entry.param),
									outputValue(entry.output),
									`&mal_site_${entry.param}`,
									"goto mal_done;",
									strings,
									true,
									inputs,
									false,
									true,
								),
							);
						cleanup.push(`free(${output});`);
						return;
					}
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
					if (
						(value.kind === "record" ||
							value.kind === "union" ||
							value.kind === "tagged") &&
						constArguments.has(index)
					) {
						body.push(
							...this.read(
								value,
								param.type,
								argument(entry.param),
								local,
								`&mal_site_${String(entry.param)}`,
								"goto mal_done;",
								strings,
								true,
								inputs,
								false,
								true,
							),
						);
						return;
					}
					const site = `&mal_site_${String(entry.param)}`;
					const source = argument(entry.param);
					const bounded =
						binding.global?.access === "set" ? binding.global.bounded : undefined;
					if (bounded !== undefined) {
						const capacity = `sizeof(${globalArrayStorage(binding)})`;
						if (bounded.format === "string") {
							const text = this.#fresh("string");
							strings.push(text);
							body.push(
								`if (!mal_ffi_to_string(vm, ${source}, false, MAL_FFI_STRING_BORROW, ${site}, &${text})) goto mal_done;`,
								`if (${text}.length >= ${capacity}) { mal_ffi_expected(vm, ${site}, "UTF-8 text shorter than the declared array capacity"); goto mal_done; }`,
								`__builtin_memset(${local}, 0, ${capacity});`,
								`__builtin_memcpy(${local}, ${text}.data, ${text}.length);`,
							);
						} else {
							const bytes = this.#fresh("bytes");
							const length = this.#fresh("length");
							locals.push(`void *${bytes};`, `size_t ${length};`);
							body.push(
								`if (!mal_ffi_to_bytes(vm, ${source}, false, false, ${site}, &${bytes}, &${length}, nullptr)) goto mal_done;`,
								`if (${length} != ${capacity}) { mal_ffi_expected(vm, ${site}, "bytes matching the declared array capacity"); goto mal_done; }`,
								`__builtin_memcpy(${local}, ${bytes}, ${capacity});`,
							);
						}
						return;
					}
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
							...this.#retainCallbackOwners(
								binding,
								context,
								argument,
								inputs,
								"goto mal_done;",
								owner === undefined ? undefined : "mal_owner",
							).map((line) => `\t${line}`),
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
					// Const members prohibit the assignments used by inline array staging.
					if (
						value.kind === "sequence" &&
						(this.#immutableRecord(value.element) ||
							(value.of.kind === "array" && this.#constStorage(value.element)))
					) {
						const elements = `mal_elements_${index}`;
						const length = `mal_length_${index}`;
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						const native = this.#fresh("native_element");
						locals.push(
							`${pointerDeclaration(value.element, elements)} = nullptr;`,
							`int32_t ${length};`,
						);
						cleanup.push(`free(${elements});`);
						body.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &${length})) goto mal_done;`,
							`static_assert(sizeof(*${elements}) % _Alignof(__typeof__(*${elements})) == 0, "FFI array stride must preserve C alignment");`,
							`if (${length} > 0) {`,
							`\t${elements} = mal_ffi_allocate_storage((size_t) ${length}, sizeof(*${elements}), _Alignof(__typeof__(*${elements})));`,
							`\tif (${elements} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
							"}",
							`for (int32_t ${position} = 0; ${position} < ${length}; ${position}++) {`,
							`\tMalValue ${element};`,
							`\tif (!mal_ffi_element(vm, ${source}, ${position}, ${length}, ${site}, &${element})) goto mal_done;`,
							...this.read(
								value.of,
								value.element,
								element,
								value.of.kind === "array" ? `${elements}[${position}]` : native,
								site,
								"goto mal_done;",
								strings,
								false,
								inputs,
								false,
								true,
							).map((line) => `\t${line}`),
							...(value.of.kind === "array"
								? []
								: [
										`\t__builtin_memcpy(&${elements}[${position}], &${native}, sizeof(${native}));`,
									]),
							"}",
							`${local} = (${localDeclaration(param.type, "")}) ${elements};`,
						);
						setCount(index, length, site, body);
						return;
					}
					if (value.kind === "sequence") {
						const elements = `mal_elements_${String(index)}`;
						const length = `mal_length_${String(index)}`;
						const view = binding.params[entry.param]!.view;
						const converted: Array<string> = [];
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						// Each string element needs its own copy; the frame's string buffers hold one value each.
						const texts = value.of.kind === "string";
						const storage = `mal_storage_${String(index)}`;
						locals.push(
							`${pointerDeclaration(value.element, elements)} = nullptr;`,
							`int32_t ${length} = 0;`,
							`alignas(_Alignof(__typeof__(*${elements})) <= MAL_FFI_ARRAY_INLINE ? _Alignof(__typeof__(*${elements})) : _Alignof(max_align_t)) unsigned char ${storage}[MAL_FFI_ARRAY_INLINE];`,
							`static_assert(sizeof(*${elements}) % _Alignof(__typeof__(*${elements})) == 0, "FFI array stride must preserve C alignment");`,
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
						converted.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &${length})) goto mal_done;`,
							`if (${length} > 0 && _Alignof(__typeof__(*${elements})) <= MAL_FFI_ARRAY_INLINE && (size_t) ${length} <= sizeof(${storage}) / sizeof(*${elements})) {`,
							`\t${elements} = (void *) ${storage};`,
							// String elements must start null, since cleanup frees every slot.
							...(texts
								? [
										`\t__builtin_memset(${storage}, 0, (size_t) ${length} * sizeof(*${elements}));`,
									]
								: []),
							`} else if (${length} > 0) {`,
							`\t${elements} = mal_ffi_calloc_storage((size_t) ${length}, sizeof(*${elements}), _Alignof(__typeof__(*${elements})));`,
							`\tif (${elements} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }`,
							"}",
							...(bulk === undefined
								? sequential
								: [
										`if (${bulk.fields === "0" ? "true" : `(size_t) ${length} <= ${bulk.inline} / ${bulk.fields}`}) ${bulk.values} = ${bulk.storage};`,
										`else if (${length} > 0) {`,
										`\t${bulk.values} = mal_ffi_allocate_storage((size_t) ${length}, sizeof(MalValue) * ${bulk.fields}, _Alignof(MalValue));`,
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
						setCount(index, length, site, converted);
						if (view === undefined) body.push(...converted);
						else {
							const selected = `mal_numeric_view_${index}`;
							const data = `mal_numeric_data_${index}`;
							const pin = callsBack ? `&mal_numeric_pin_${index}` : "nullptr";
							locals.push(`bool ${selected};`, `const void *${data};`);
							if (callsBack) {
								locals.push(`void *mal_numeric_pin_${index} = nullptr;`);
								cleanup.push(`mal_ffi_unpin(mal_numeric_pin_${index});`);
							}
							body.push(
								`${selected} = mal_ffi_is_typed_array(${source});`,
								`if (!${selected}) {`,
								...converted.map((line) => `\t${line}`),
								"}",
							);
							buffers.push(
								`if (${selected}) {`,
								`if (!mal_ffi_to_numeric_view(vm, ${source}, MAL_FFI_NUMERIC_${view.slice(0, -5).toUpperCase()}, sizeof(*${local}), _Alignof(__typeof__(*${local})), ${site}, &${data}, &${length}, ${pin})) goto mal_done;`,
								`${local} = (${localDeclaration(param.type, "")}) ${data};`,
							);
							setCount(index, length, site, buffers);
							buffers.push("}");
						}
						return;
					}
					if (
						value.kind === "handle" &&
						(runsJavaScript ||
							constArguments.has(index) ||
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
								? `${constArguments.has(index) ? localDeclaration(param.type, local) : local} = *(${handle.spelling} *) ${pointer};`
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
		const claims = transactional
			? this.#resultClaims(binding, "mal_return", outputValue)
			: [];
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
			after.push(
				...enter,
				`${call};`,
				...callbackReturns,
				...leave,
				...closes,
				...claims,
			);
		} else if (
			binding.global?.access === "get" &&
			resolveCType(this.#model, binding.global.declaration.type).kind === "array"
		) {
			locals.push(`${globalArrayStorage(binding)} *mal_return = nullptr;`);
			const bounded = binding.global.bounded;
			const produce =
				bounded?.format === "bytes"
					? ["mal_result = mal_ffi_from_bytes(vm, mal_return, sizeof(*mal_return));"]
					: bounded?.format === "string"
						? [
								"const char *mal_terminator = __builtin_memchr(mal_return, 0, sizeof(*mal_return));",
								'if (mal_terminator == nullptr) { mal_ffi_expected(vm, &mal_site_result, "NUL-terminated UTF-8 within the declared array capacity"); goto mal_done; }',
								"mal_result = mal_ffi_from_string_length(vm, (const char *) mal_return, (size_t) (mal_terminator - (const char *) mal_return));",
							]
						: this.#produce(binding.returns, "(*mal_return)", "mal_result");
			after.push(
				`mal_return = mal_ffi_allocate_storage(1, sizeof(*mal_return), _Alignof(${globalArrayStorage(binding)}));`,
				"if (mal_return == nullptr) { mal_ffi_out_of_memory(vm); goto mal_done; }",
				`${declaration.name}(mal_return);`,
				...produce,
			);
			cleanup.push("free(mal_return);");
		} else {
			const returnDeclaration =
				binding.returns.kind === "callable"
					? `${binding.returns.targetType} mal_return`
					: localDeclaration(declaration.returns, "mal_return");
			const initialize = this.#immutableRecord(declaration.returns);
			if (!initialize) locals.push(`${returnDeclaration};`);
			const owned = this.#owned(
				binding.returns,
				"mal_return",
				"mal_result",
				count,
				"&mal_site_result",
				callsBack,
				"&mal_discards",
				results,
			);
			const record = intoRecord(binding);
			after.push(
				...enter,
				`${initialize ? returnDeclaration : "mal_return"} = ${call};`,
				...callbackReturns,
				...leave,
				...closes,
				...claims,
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
					...this.#output(
						binding,
						index,
						outputValue(index),
						`mal_outputs[${String(first + index)}]`,
						"",
						results,
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
			...(transactional
				? [
						`\tmal_ffi_results_init(&mal_results, mal_result_claims, mal_result_handles, ${discardCount});`,
					]
				: []),
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
			...(transactional
				? [
						"\tmal_ffi_results_finish(vm, &mal_results);",
						"\tif (mal_ffi_threw(vm)) mal_result = mal_ffi_undefined();",
					]
				: []),
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
		const constArguments = this.#constArguments(binding);
		const constOutputs = this.#constOutputs(binding);
		const outputValue = (index: number): string =>
			constOutputs.has(index)
				? `(*mal_ctx->mal_output_${index})`
				: `mal_ctx->mal_output_${index}`;
		const initializeReturn = this.#immutableRecord(declaration.returns);
		const returnValue = initializeReturn
			? "(*mal_ctx->mal_return)"
			: "mal_ctx->mal_return";
		const context = `MalFfiAsync_${name}`;
		const callbacks: Array<{
			readonly index: number;
			readonly slot?: string;
			readonly retained: boolean;
			readonly replacement?: string;
			readonly closeKey?: number;
			readonly registrationResult: boolean;
		}> = [];
		const discardCount = this.#discardCount(binding);
		const transactional = this.#transactionalResults(binding);
		const results = transactional ? "&mal_results" : undefined;
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
						`if (mal_ffi_discard_claim(nullptr, &mal_ctx->mal_discards, &mal_ffi_type_${handle.name}, (void *) (${expression}), ${value.fresh === true})) mal_ffi_destroy_${handle.name}((void *) (${expression}));`,
					];
		};
		const nativeDisposals = [
			...discard(binding.returns, returnValue),
			...binding.outputs.flatMap((output, index) =>
				discard(output.value, outputValue(index)),
			),
		];
		const tracksRun =
			binding.closes !== undefined ||
			nativeDisposals.length > 0 ||
			binding.params.some(({ value }) => value.kind === "callback" && value.kept);
		const fields: Array<string> = [];
		if (discardCount > 0)
			fields.push(
				"MalFfiDiscards mal_discards;",
				`MalFfiDiscardedHandle mal_discarded[${discardCount}];`,
			);
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
		if (
			managedHandles ||
			compoundInputs ||
			this.#resultGuards(binding, "").length > 0 ||
			binding.outputs.some((output) => output.capacity !== undefined)
		)
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
		const setCount = (
			counted: number,
			count: string,
			site: string,
			into = buffers,
		): void => {
			const index = binding.arguments.findIndex(
				(entry) => entry.kind === "count" && entry.of.includes(counted),
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
			into.push(
				`if (!mal_ffi_check_count(vm, (size_t) (${count}), ${bits}, ${signed}, ${site})) goto mal_failed;`,
				...(entry?.kind === "count" && entry.of.length > 1
					? [
							`if (mal_count_set_${index} && (uint64_t) mal_ctx->mal_argument_${index} != (uint64_t) (${count})) { mal_ffi_expected(vm, ${site}, "a length matching the other arguments sharing this count"); goto mal_failed; }`,
							`mal_count_set_${index} = true;`,
						]
					: []),
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
			fields.push(
				`${localDeclaration(constArguments.has(index) ? { kind: "pointer", to: param.type } : param.type, `mal_argument_${String(index)}`)};`,
			);
			const resolved = resolveCType(this.#model, param.type);
			const pointee = resolved.kind === "pointer" ? resolved.to : param.type;
			switch (entry.kind) {
				case "count":
					if (entry.of.length > 1) locals.push(`bool mal_count_set_${index} = false;`);
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
					if (binding.outputs[entry.output]!.capacity !== undefined) {
						const site =
							entry.kind === "inout" ? `&mal_site_${entry.param}` : "&mal_site_result";
						const prepared = this.#callerArray(
							binding,
							entry,
							index,
							"mal_ctx->",
							entry.kind === "inout" ? argument(entry.param) : undefined,
							site,
							"goto mal_failed;",
						);
						fields.push(...prepared.declarations);
						const into = entry.kind === "inout" ? body : buffers;
						into.push(...prepared.lengthLines);
						if (entry.kind === "inout") setCount(index, prepared.length, site, into);
						into.push(...prepared.lines);
						frees.push(prepared.cleanup);
						return;
					}

					if (constOutputs.has(entry.output)) {
						fields.push(`typeof_unqual(${localDeclaration(pointee, "")}) *${output};`);
						const storage = `mal_ctx->${output}`;
						const native = this.#fresh("native_output");
						const input =
							entry.kind === "inout" ? binding.params[entry.param]!.value : undefined;
						if (entry.kind === "inout" && input?.kind !== "array")
							body.push(
								...this.read(
									binding.params[entry.param]!.value,
									pointee,
									argument(entry.param),
									native,
									`&mal_site_${entry.param}`,
									"goto mal_failed;",
									strings,
									true,
									inputs,
									false,
									true,
								),
							);
						body.push(
							`${storage} = mal_ffi_allocate_storage(1, sizeof(*${storage}), _Alignof(__typeof__(*${storage})));`,
							`if (${storage} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }`,
							...(entry.kind === "inout" && input?.kind !== "array"
								? [`__builtin_memcpy(${storage}, &${native}, sizeof(${native}));`]
								: []),
							`${target} = ${storage};`,
						);
						if (entry.kind === "inout" && input?.kind === "array")
							body.push(
								...this.read(
									input,
									pointee,
									argument(entry.param),
									outputValue(entry.output),
									`&mal_site_${entry.param}`,
									"goto mal_failed;",
									strings,
									true,
									inputs,
									false,
									true,
								),
							);
						frees.push(`free(${storage});`);
						return;
					}
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
					if (
						(value.kind === "record" ||
							value.kind === "union" ||
							value.kind === "tagged") &&
						constArguments.has(index)
					) {
						const native = this.#fresh("native_argument");
						body.push(
							...this.read(
								value,
								param.type,
								source,
								native,
								site,
								"goto mal_failed;",
								strings,
								true,
								inputs,
								false,
								true,
							),
							`${target} = mal_ffi_allocate_storage(1, sizeof(${native}), _Alignof(__typeof__(${native})));`,
							`if (${target} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }`,
							`__builtin_memcpy(${target}, &${native}, sizeof(${native}));`,
						);
						frees.push(`free(${target});`);
						return;
					}
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
							...(value.kept
								? this.#retainCallbackOwners(
										binding,
										`mal_ctx->${field}`,
										argument,
										inputs,
										"goto mal_failed;",
									).map((line) => `\t${line}`)
								: []),
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
					if (
						value.kind === "sequence" &&
						(this.#immutableRecord(value.element) ||
							(value.of.kind === "array" && this.#constStorage(value.element)))
					) {
						const elements = `mal_elements_${index}`;
						const length = `mal_length_${index}`;
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						const native = this.#fresh("native_element");
						fields.push(
							`${pointerDeclaration(value.element, elements)};`,
							`int32_t ${length};`,
						);
						frees.push(`free(mal_ctx->${elements});`);
						body.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &mal_ctx->${length})) goto mal_failed;`,
							`static_assert(sizeof(*mal_ctx->${elements}) % _Alignof(__typeof__(*mal_ctx->${elements})) == 0, "FFI array stride must preserve C alignment");`,
							`if (mal_ctx->${length} > 0) {`,
							`\tmal_ctx->${elements} = mal_ffi_allocate_storage((size_t) mal_ctx->${length}, sizeof(*mal_ctx->${elements}), _Alignof(__typeof__(*mal_ctx->${elements})));`,
							`\tif (mal_ctx->${elements} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }`,
							"}",
							`for (int32_t ${position} = 0; ${position} < mal_ctx->${length}; ${position}++) {`,
							`\tMalValue ${element};`,
							`\tif (!mal_ffi_element(vm, ${source}, ${position}, mal_ctx->${length}, ${site}, &${element})) goto mal_failed;`,
							...this.read(
								value.of,
								value.element,
								element,
								value.of.kind === "array" ? `mal_ctx->${elements}[${position}]` : native,
								site,
								"goto mal_failed;",
								strings,
								false,
								inputs,
								false,
								true,
							).map((line) => `\t${line}`),
							...(value.of.kind === "array"
								? []
								: [
										`\t__builtin_memcpy(&mal_ctx->${elements}[${position}], &${native}, sizeof(${native}));`,
									]),
							"}",
							`${target} = (${localDeclaration(param.type, "")}) mal_ctx->${elements};`,
						);
						setCount(index, `mal_ctx->${length}`, site);
						return;
					}
					if (value.kind === "sequence") {
						// The context owns a copy of the elements, since the call outlives this frame.
						const elements = `mal_elements_${String(index)}`;
						const length = `mal_length_${String(index)}`;
						const view = binding.params[entry.param]!.view;
						const converted: Array<string> = [];
						const position = this.#fresh("index");
						const element = this.#fresh("element");
						const texts = value.of.kind === "string";
						fields.push(
							`${pointerDeclaration(value.element, elements)};`,
							`int32_t ${length};`,
						);
						if (texts) {
							const freed = this.#fresh("index");
							frees.push(
								`if (mal_ctx->${elements} != nullptr) for (int32_t ${freed} = 0; ${freed} < mal_ctx->${length}; ${freed}++) free((void *) mal_ctx->${elements}[${freed}]);`,
							);
						}
						frees.push(`free(mal_ctx->${elements});`);
						converted.push(
							`if (!mal_ffi_to_array_length(vm, ${source}, ${value.nullable}, ${site}, &mal_ctx->${length})) goto mal_failed;`,
							`if (mal_ctx->${length} > 0) {`,
							`static_assert(sizeof(*mal_ctx->${elements}) % _Alignof(__typeof__(*mal_ctx->${elements})) == 0, "FFI array stride must preserve C alignment");`,
							`\tmal_ctx->${elements} = mal_ffi_calloc_storage((size_t) mal_ctx->${length}, sizeof(*mal_ctx->${elements}), _Alignof(__typeof__(*mal_ctx->${elements})));`,
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
						if (view === undefined) body.push(...converted);
						else {
							const selected = `mal_numeric_view_${index}`;
							const data = `mal_numeric_data_${index}`;
							locals.push(`bool ${selected};`, `const void *${data};`);
							body.push(
								`${selected} = mal_ffi_is_typed_array(${source});`,
								`if (!${selected}) {`,
								...converted.map((line) => `\t${line}`),
								"}",
							);
							buffers.push(
								`if (${selected}) {`,
								`if (!mal_ffi_to_numeric_view(vm, ${source}, MAL_FFI_NUMERIC_${view.slice(0, -5).toUpperCase()}, sizeof(*mal_ctx->${elements}), _Alignof(__typeof__(*mal_ctx->${elements})), ${site}, &${data}, &mal_ctx->${length}, nullptr)) goto mal_failed;`,
								`if (mal_ctx->${length} > 0) {`,
								`\tmal_ctx->${elements} = mal_ffi_allocate_storage((size_t) mal_ctx->${length}, sizeof(*mal_ctx->${elements}), _Alignof(__typeof__(*mal_ctx->${elements})));`,
								`\tif (mal_ctx->${elements} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }`,
								`\t__builtin_memcpy(mal_ctx->${elements}, ${data}, (size_t) mal_ctx->${length} * sizeof(*mal_ctx->${elements}));`,
								"}",
								`${target} = (${localDeclaration(param.type, "")}) mal_ctx->${elements};`,
								"}",
							);
						}
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
							...(constArguments.has(index)
								? [
										`${target} = mal_ffi_allocate_storage(1, sizeof(*${target}), _Alignof(${handle.spelling}));`,
										`if (${target} == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }`,
										`__builtin_memcpy(${target}, ${pointer}, sizeof(*${target}));`,
									]
								: [
										value.pass === "copy"
											? `${target} = *(${handle.spelling} *) ${pointer};`
											: `${target} = (${localDeclaration(param.type, "")}) ${pointer};`,
									]),
						);
						if (constArguments.has(index)) frees.push(`free(${target});`);
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
				`${initializeReturn ? localDeclaration({ kind: "pointer", to: declaration.returns }, "mal_return") : binding.returns.kind === "callable" ? `${binding.returns.targetType} mal_return` : localDeclaration(declaration.returns, "mal_return")};`,
			);
		if (initializeReturn) {
			buffers.push(
				`mal_ctx->mal_return = mal_ffi_allocate_storage(1, sizeof(*mal_ctx->mal_return), _Alignof(${localDeclaration(declaration.returns, "")}));`,
				"if (mal_ctx->mal_return == nullptr) { mal_ffi_out_of_memory(vm); goto mal_failed; }",
			);
			frees.push("free(mal_ctx->mal_return);");
		}
		for (const temporary of strings) fields.push(`MalFfiString ${temporary};`);
		const call = `${declaration.name}(${declaration.params.map((_, index) => `${constArguments.has(index) ? "*" : ""}mal_ctx->mal_argument_${String(index)}`).join(", ")})`;
		const count = countValue(binding, binding.resultCount, "mal_ctx->");
		const produce: Array<string> = returns
			? this.#owned(
					binding.returns,
					returnValue,
					"mal_result",
					count,
					"&mal_site_result",
					true,
					"&mal_ctx->mal_discards",
					results,
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
					this.#output(
						binding,
						index,
						outputValue(index),
						`mal_outputs[${String(first + index)}]`,
						"mal_ctx->",
						results,
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
			...(initializeReturn
				? [
						`\t${localDeclaration(declaration.returns, "mal_native_return")} = ${call};`,
						"\t__builtin_memcpy(mal_ctx->mal_return, &mal_native_return, sizeof(mal_native_return));",
					]
				: [`\t${returns ? "mal_ctx->mal_return = " : ""}${call};`]),
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
			...(transactional
				? [
						`\tMalFfiResultClaim mal_result_claims[${discardCount}];`,
						`\tMalValue mal_result_handles[${2 * discardCount}];`,
						"\tMalFfiResults mal_results;",
						`\tmal_ffi_results_init(&mal_results, mal_result_claims, mal_result_handles, ${discardCount});`,
						...this.#resultClaims(binding, returnValue, outputValue).map(
							(line) => `\t${line}`,
						),
					]
				: []),
			...(nativeDisposals.length === 0 ? [] : ["\tmal_ctx->mal_result_observed = true;"]),
			...produce.map((line) => `\t${line}`),
			"\tgoto mal_done;",
			"mal_done:",
			...(transactional
				? [
						"\tmal_ffi_results_finish(vm, &mal_results);",
						"\tif (mal_ffi_threw(vm)) mal_result = mal_ffi_undefined();",
					]
				: []),
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
			...(discardCount > 0 ? ["\tmal_ffi_discards_finish(&mal_ctx->mal_discards);"] : []),
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
			`\t${context} *mal_ctx = mal_ffi_calloc_storage(1, sizeof(*mal_ctx), _Alignof(${context}));`,
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
			...(discardCount > 0
				? [
						`\tif (!mal_ffi_discards_init(vm, &mal_ctx->mal_discards, mal_ctx->mal_discarded, ${discardCount})) goto mal_failed;`,
					]
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
			...plan.dispatchers.map((dispatch) => dispatch.name),
			...plan.natives.keys(),
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
	const dispatchers = plan.dispatchers.filter(
		(dispatch) => selectedExports === undefined || selectedExports.has(dispatch.name),
	);
	const dispatchCases = new Set(
		dispatchers.flatMap((dispatch) => dispatch.cases.map((binding) => binding.name)),
	);
	const bindings = plan.functions.filter(
		(binding) =>
			selectedExports === undefined ||
			dispatchCases.has(binding.name) ||
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
	const dispatchFunctions = dispatchers.flatMap((dispatch) => [
		`static MalValue mal_ffi_function_${dispatch.name}(MalVm *vm, MalValue mal_this, const MalValue *mal_args, int32_t mal_argc, MalValue mal_new_target, MalValue mal_callee) {`,
		"\t(void) mal_this; (void) mal_new_target; (void) mal_callee;",
		`\tstatic const MalFfiSite mal_site = { ${cString(dispatch.name)}, "signature", nullptr };`,
		"\tMalFfiString mal_signature = {};",
		"\tif (!mal_ffi_to_string(vm, mal_argc > 0 ? mal_args[0] : mal_ffi_undefined(), false, 0, &mal_site, &mal_signature)) return mal_ffi_undefined();",
		"\tint32_t mal_case = -1;",
		...dispatch.cases.map(
			(binding, index) =>
				`\t${index === 0 ? "" : "else "}if (mal_signature.length == ${String(binding.name.length)} && __builtin_memcmp(mal_signature.data, ${cString(binding.name)}, ${String(binding.name.length)}) == 0) mal_case = ${String(index)};`,
		),
		"\tmal_ffi_string_release(&mal_signature);",
		"\tswitch (mal_case) {",
		...dispatch.cases.flatMap((binding, index) => [
			`\t\tcase ${String(index)}:`,
			`\t\t\tif (mal_argc != ${String(binding.params.length + 1)}) { mal_ffi_expected(vm, &mal_site, "the declared argument count for this signature"); return mal_ffi_undefined(); }`,
			`\t\t\treturn mal_ffi_call_${binding.name}(vm, mal_args + 1, mal_argc - 1, true${hasInto(binding) ? ", nullptr, nullptr" : ""});`,
		]),
		'\t\tdefault: mal_ffi_expected(vm, &mal_site, "a declared variadic signature"); return mal_ffi_undefined();',
		"\t}",
		"}",
	]);
	const exports = [
		...dispatchers.map((dispatch) => ({
			name: dispatch.name,
			entry: `{ ${cString(dispatch.name)}, 1, mal_ffi_function_${dispatch.name}, nullptr }`,
		})),
		...[...plan.natives.keys()].map((name) => ({
			name,
			entry: `{ ${cString(name)}, 0, mal_ffi_native_zero_${name}, nullptr }`,
		})),
		...[...plan.handles.values()].flatMap((handle) =>
			handle.allocator === undefined
				? []
				: [
						{
							name: handle.allocator,
							entry: `{ ${cString(handle.allocator)}, ${handle.trailing === undefined ? "0" : "1"}, mal_ffi_allocate_${handle.allocator}, nullptr }`,
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
	const retainedGlobals = new Set<string>();
	const source = [
		`// Generated binding for ${specifier}.`,
		'#include "mal_ffi.h"',
		"#include <stdlib.h>",
		...headers.map((header) => `#include "${header}"`),
		"",
		...bindings.flatMap((binding) => {
			if (binding.global === undefined) return [];
			const name = binding.global.declaration.name;
			const retained = binding.global.retained;
			if (retained !== undefined) {
				if (retainedGlobals.has(name)) return [];
				retainedGlobals.add(name);
				const prefix = `mal_ffi_global_${name}`;
				const count = retained.count;
				const countName = count?.declaration.name;
				return [
					`static bool ${prefix}_read(void **data, size_t *length) {`,
					`\t*data = (void *) ${name};`,
					...(countName === undefined
						? ["\t*length = 0;"]
						: [
								...(count?.signed === true
									? [`\tif (${countName} < 0) return false;`]
									: []),
								`\tuint64_t count = (uint64_t) ${countName};`,
								"\tif (count > SIZE_MAX) return false;",
								"\t*length = (size_t) count;",
							]),
					"\treturn true;",
					"}",
					`static void ${prefix}_write(void *data, size_t length) {`,
					`\t${name} = (__typeof__(${name})) data;`,
					...(countName === undefined
						? ["\t(void) length;"]
						: [`\t${countName} = (__typeof__(${countName})) length;`]),
					"}",
					`static const MalFfiGlobal ${prefix} = { (const void *) &${name}, ${countName === undefined ? "nullptr" : `(const void *) &${countName}`}, ${prefix}_read, ${prefix}_write, ${String(count?.bits ?? 0)}, ${count?.signed === true ? "true" : "false"}, ${retained.format === "string" ? "true" : "false"} };`,
				];
			}
			const array = resolveCType(model, binding.global.declaration.type);
			if (binding.global.synchronizedCount === true) {
				const helper = binding.declaration.name;
				return [
					`static void ${helper}_read(void *out) { *(__typeof__(${name}) *) out = ${name}; }`,
					`static __typeof__(${name}) ${helper}(void) {`,
					`\t__typeof__(${name}) value;`,
					`\tmal_ffi_read_global_count(${helper}_read, (void *) &value);`,
					"\treturn value;",
					"}",
				];
			}
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
		...[...plan.natives.keys()].map(
			(name) => `static const MalFfiHandleType mal_ffi_type_${name};`,
		),
		...[...plan.handles.keys()].map(
			(name) => `static const MalFfiHandleType mal_ffi_type_${name};`,
		),
		"",
		...writer.callableDeclarations(),
		...writer.nativeTypes(),
		...writer.recordHelpers(),
		...writer.handleTypes(),
		...writer.callableHelpers(),
		...functions,
		...dispatchFunctions,
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
			dispatchers,
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
