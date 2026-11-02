import { createHash } from "node:crypto";
import type {
	MaligatorFfiCallback,
	MaligatorFfiCount,
	MaligatorFfiFieldFacts,
	MaligatorFfiShape,
	MaligatorFfiValueFacts,
	MaligatorFfiVariant,
} from "../public-api.d.ts";
import type { CField, CFunction, CGlobal, CModel, CRecord } from "./c-model.ts";
import {
	cRecordAccesses,
	cRecordHasConstMembers,
	promotedCFields,
	resolveCFieldPath,
	resolveCType,
} from "./c-model.ts";
import { formatCDeclaration, parseCType } from "./c-type.ts";
import type { CType } from "./c-type.ts";
import type { LibraryFacts } from "./contract.ts";
import { FfiError } from "./ffi-error.ts";
import type { FfiText } from "./text.ts";

/**
 * How a C value crosses into JavaScript. Mappings follow fixed rules so the same
 * header and facts always produce the same module.
 */
export type JsValue =
	| { readonly kind: "undefined" }
	| {
			readonly kind: "callable";
			readonly name: string;
			readonly targetType: string;
			readonly site: string;
			readonly signature: BoundFunction;
			readonly nullable: true;
			readonly owner?: string;
	  }
	| { readonly kind: "boolean" }
	/** An exact integer of at most 32 bits; other numbers throw on input. */
	| { readonly kind: "integer"; readonly bits: number; readonly signed: boolean }
	| { readonly kind: "float"; readonly bits: number }
	/** An integer wider than 32 bits, exact in both directions. */
	| { readonly kind: "bigint"; readonly bits: number; readonly signed: boolean }
	/**
	 * UTF-8, terminated or byte-counted. Inputs are borrowed for the call; results are copied,
	 * then released with `free` when the caller owns them.
	 */
	| {
			readonly kind: "string";
			readonly nullable: boolean;
			readonly counted?: true;
			readonly free?: string;
	  }
	/**
	 * Input bytes C uses in place during the call; results copied into a Uint8Array.
	 * `writable` inputs reject immutable buffers.
	 */
	| {
			readonly kind: "bytes";
			readonly nullable: boolean;
			readonly free?: string;
			readonly writable?: true;
	  }
	/** A C array of `element` values, copied from or into a JavaScript array. */
	| {
			readonly kind: "sequence";
			readonly of: JsValue;
			readonly element: CType;
			readonly nullable: boolean;
			readonly free?: string;
	  }
	/** A struct passed by value as a plain object. */
	| { readonly kind: "record"; readonly name: string }
	| {
			readonly kind: "tagged";
			readonly name: string;
			readonly tag: string;
			readonly cases: ReadonlyArray<{
				readonly literal: string;
				readonly value: JsValue;
			}>;
			readonly alias?: string;
	  }
	| {
			readonly kind: "union";
			readonly name: string;
			readonly of: JsValue;
			readonly alias?: string;
	  }
	| { readonly kind: "array"; readonly of: JsValue; readonly length: number }
	/**
	 * A JavaScript function the library calls through a generated trampoline of the C
	 * function type `type`, during the call or, when kept, until it releases it.
	 */
	| {
			readonly kind: "callback";
			readonly type: Extract<CType, { kind: "function" }>;
			/**
			 * Per C parameter of the callback: its value, the user data it receives, or the
			 * count of a buffer or array parameter, which JavaScript does not see.
			 */
			readonly params: ReadonlyArray<JsValue | "data" | "count">;
			/** Per C parameter: the parameter holding its byte or element count. */
			readonly counts: ReadonlyArray<number | undefined>;
			readonly returns: JsValue;
			readonly returnLifetime?: "call" | "registration";
			readonly resultCount?: {
				readonly param: number;
				readonly bits: number;
				readonly signed: boolean;
			};
			readonly nullable: boolean;
			readonly kept: boolean;
			/**
			 * For a callback the next call replaces: the C parameter whose handle keys it,
			 * and, without user data, the callback parameter that passes that handle back.
			 */
			readonly replaced?: { readonly key?: number; readonly keyParam?: number };
			readonly closes?: {
				readonly param: number;
				readonly key: number;
				readonly keyParam?: number;
			};
			/** The C function that returns the user data from callback parameter `param`. */
			readonly lookup?: { readonly function: string; readonly param: number };
			/** Calls from other threads queue for the VM thread with copied arguments. */
			readonly queued?: true | "wait";
	  }
	/**
	 * A resource handle. C receives the handle's pointer, a copy of its struct, or
	 * the struct's address for the library to update in place.
	 */
	| {
			readonly kind: "handle";
			readonly name: string;
			readonly pass: "pointer" | "copy" | "reference";
			readonly nullable: boolean;
			/** For results: whether closing the new handle releases the resource. */
			readonly owned: boolean;
			readonly fresh?: true;
	  };

type Mapping = { readonly value: JsValue } | { readonly gap: string };

export interface MappedParameter {
	readonly name: string;
	readonly type: CType;
	readonly value: JsValue;
}

/** How a binding produces one C argument. */
export type Argument =
	/** Converted from JavaScript parameter `param`. */
	| { readonly kind: "input"; readonly param: number }
	/**
	 * The byte or element count of the buffer or array that argument `of` passes. With
	 * `output`, the address of a local holding the buffer's size, which the function
	 * updates to the count it used and the binding returns as that output.
	 */
	| { readonly kind: "count"; readonly of: number; readonly output?: number }
	/** The address of a zeroed local the function writes; returned as output `output`. */
	| { readonly kind: "out"; readonly output: number }
	/** The address of a local read from parameter `param` and returned as `output`. */
	| { readonly kind: "inout"; readonly param: number; readonly output: number }
	/** The address of a local the function writes with the count of its result. */
	| { readonly kind: "result-count" }
	/** The user data that routes the callback argument `of` to its JavaScript function. */
	| { readonly kind: "callback-data"; readonly of: number }
	/** The destructor the library calls when it drops the kept callback argument `of`. */
	| { readonly kind: "callback-release"; readonly of: number }
	/** A C expression the contract fixes, such as a macro name. */
	| {
			readonly kind: "constant";
			readonly expression: string;
			readonly sizeLimit?: string;
	  };

/** A value the function writes through a pointer, returned beside its result. */
export interface MappedOutput {
	readonly name: string;
	/** The pointee type. */
	readonly type: CType;
	readonly value: JsValue;
	/** The C parameter holding this output's byte or element count. */
	readonly count?: number;
}

export interface BoundFunction {
	readonly name: string;
	readonly global?: GlobalAccessor;
	readonly declaration: CFunction;
	/** The JavaScript parameters, in order. */
	readonly params: ReadonlyArray<MappedParameter>;
	/** How each C argument is produced, by C parameter position. */
	readonly arguments: ReadonlyArray<Argument>;
	readonly returns: JsValue;
	/** For a buffer or array result: the C parameter that carries its count. */
	readonly resultCount?: number;
	/** With outputs, the function returns `{ result, ...outputs }` instead of its result. */
	readonly outputs: ReadonlyArray<MappedOutput>;
	/** The parameter whose handle this destroy function releases, closed after the call. */
	readonly closes?: number;
	/** An export that runs the C call on a worker thread and returns a promise. */
	readonly async?: string;
}

/** A missing fact: where in the declaration it is needed and why. */
export interface Gap {
	/** `return`, `param 2 (title)`, or `arguments` for variadics. */
	readonly at: string;
	readonly reason: string;
}

export interface UnboundFunction {
	readonly name: string;
	readonly global?: GlobalAccessor;
	readonly declaration: CFunction;
	readonly gaps: ReadonlyArray<Gap>;
}

export interface GlobalAccessor {
	readonly declaration: CGlobal;
	readonly access: "get" | "set";
	readonly bounded?: { readonly format: "string" | "bytes" };
}

export interface MappedField {
	readonly name: string;
	readonly type: CType;
	readonly value: JsValue;
	readonly bitWidth?: number;
	readonly doc?: FfiText;
}

export interface ManagedField {
	readonly kind: "bytes" | "string";
	readonly name: string;
	readonly type: CType;
	readonly count: string;
	readonly countType: CType;
	readonly bits: number;
	readonly signed: boolean;
	readonly writable: boolean;
	readonly doc?: FfiText;
}

export interface MappedRecord {
	/** The type name generated declarations use. */
	readonly name: string;
	/** How C code spells the type: a typedef name or `struct tag`. */
	readonly spelling: string;
	readonly record: CRecord;
	readonly fields: ReadonlyArray<MappedField>;
	readonly private?: true;
}

export interface MappedUnion {
	readonly name: string;
	readonly spelling: string;
	readonly record: CRecord;
	readonly member: MappedField;
	readonly alias?: string;
}

export interface MappedTagged {
	readonly name: string;
	readonly spelling: string;
	readonly record: CRecord;
	readonly tag: MappedField;
	readonly cases: ReadonlyArray<{
		readonly expression: string;
		readonly literal: string;
		readonly selection: ReadonlyArray<string>;
		readonly record: MappedRecord;
	}>;
	readonly alias?: string;
}

/** A type whose values are handles, as the contract's facts and the headers define it. */
export interface HandleType {
	/** The struct the handle wraps, which also names its JavaScript type. */
	readonly name: string;
	/** How C code spells the struct type. */
	readonly spelling: string;
	/** A copy of a struct the library passes by value, or a pointer it returns. */
	readonly representation: "struct" | "pointer";
	/** Directed pointer compatibility, including transitive views. */
	readonly views: ReadonlyArray<string>;
	/** Canonical identity shared by connected pointer views. */
	readonly family: string;
	/** A factory named by the type fact, allocating stable caller-owned storage. */
	readonly allocator?: string;
	readonly destroy?: {
		readonly name: string;
		readonly success?: string;
		/** Whether the destroy function takes the struct by value or by address. */
		readonly takes: "value" | "pointer";
	};
	readonly collect: boolean;
	/** Read-only value fields and explicitly declared callable fields. */
	readonly fields: ReadonlyArray<MappedField>;
	readonly managedFields: ReadonlyArray<ManagedField>;
	readonly doc?: FfiText;
}

export interface MappedConstant {
	readonly name: string;
	readonly source: "enum" | "macro";
	readonly type: CType;
	readonly value: JsValue;
	/** Known at build time; otherwise the binding reads the C expression when it loads. */
	readonly known?: bigint | number | string;
	readonly doc?: FfiText;
}

export interface SkippedConstant {
	readonly name: string;
	readonly reason: string;
}

export interface BindingPlan {
	readonly functions: ReadonlyArray<BoundFunction>;
	/**
	 * A shared C dependency can invoke a callback while a different binding runs,
	 * including a call nested inside a call-scoped callback.
	 */
	readonly hasCallbacks: boolean;
	readonly unbound: ReadonlyArray<UnboundFunction>;
	readonly records: ReadonlyMap<string, MappedRecord>;
	readonly unions: ReadonlyMap<string, MappedUnion>;
	readonly tagged: ReadonlyMap<string, MappedTagged>;
	readonly handles: ReadonlyMap<string, HandleType>;
	readonly constants: ReadonlyArray<MappedConstant>;
	readonly skippedConstants: ReadonlyArray<SkippedConstant>;
}

type Position = "param" | "return" | "field" | "constant";

/** How C code spells a struct: `struct tag`, or the typedef that names an unnamed one. */
function recordSpelling(model: CModel, record: CRecord): string {
	if (record.named) return `${record.tag} ${record.name}`;
	const typedef = [...model.typedefs.values()].find(
		(entry) =>
			entry.type.kind === "record" &&
			entry.type.name === record.name &&
			entry.type.const !== true,
	);
	return typedef?.name ?? record.name;
}

const NO_FACTS: MaligatorFfiValueFacts = {};

function valueCount(
	facts: MaligatorFfiValueFacts,
): { kind: "bytes" | "array" | "string"; count: MaligatorFfiCount } | undefined {
	if (facts.bytes !== undefined) return { kind: "bytes", count: facts.bytes };
	if (facts.array !== undefined) return { kind: "array", count: facts.array };
	if (typeof facts.string === "object") return { kind: "string", count: facts.string };
	return undefined;
}

/** A function's facts by parameter position. */
interface FunctionFacts {
	readonly params: ReadonlyArray<MaligatorFfiValueFacts | undefined>;
	readonly returns: MaligatorFfiValueFacts;
}

const EMPTY_FACTS: LibraryFacts = { types: {}, functions: {} };

/** The struct a type fact names: a struct tag, or a typedef of a struct or struct pointer. */
function factRecord(model: CModel, key: string): CRecord | undefined {
	const record = model.records.get(key);
	if (record !== undefined) return record;
	const typedef = model.typedefs.get(key);
	if (typedef === undefined) return undefined;
	let resolved = resolveCType(model, typedef.type);
	if (resolved.kind === "pointer") resolved = resolveCType(model, resolved.to);
	return resolved.kind === "record" ? model.records.get(resolved.name) : undefined;
}

/**
 * Handle types from the contract's facts. A handle copies the struct when the
 * library passes it by value, and otherwise holds the pointer the library returns.
 */
function handleTypes(
	model: CModel,
	facts: LibraryFacts,
): Map<string, Omit<HandleType, "fields" | "managedFields">> {
	const handles = new Map<string, Omit<HandleType, "fields" | "managedFields">>();
	for (const [key, typeFacts] of Object.entries(facts.types)) {
		const handle = typeFacts.handle;
		if (
			typeFacts.fields !== undefined &&
			handle?.storage !== "caller" &&
			Object.values(typeFacts.fields).some((field) => field.callable === undefined)
		)
			throw new FfiError(`types.${key}.fields: managed fields require caller storage`);
		if (typeFacts.fields !== undefined && handle === undefined)
			throw new FfiError(`types.${key}.fields: callable fields require a handle`);
		if (handle === undefined) {
			if (!model.typedefs.has(key) && !model.records.has(key) && !model.enums.has(key))
				throw new FfiError(`types.${key}: the headers declare no type named '${key}'`);
			continue;
		}
		const record = factRecord(model, key);
		if (record === undefined) {
			throw new FfiError(`types.${key}: the headers declare no struct named '${key}'`);
		}
		if (handles.has(record.name)) {
			throw new FfiError(`types.${key}: ${record.name} already has a handle fact`);
		}
		if (handle.storage === "caller") {
			if (!record.complete || record.tag !== "struct")
				throw new FfiError(
					`types.${key}.handle.storage: caller storage needs a complete struct`,
				);
			if (
				record.fields.some((field) => {
					const type = resolveCType(model, field.type);
					return (
						type.kind === "array" && (type.length === undefined || type.length === 0)
					);
				})
			)
				throw new FfiError(
					`types.${key}.handle.storage: variable-length storage needs an allocation size`,
				);
			if (handle.destroy !== undefined || handle.collect === true)
				throw new FfiError(
					`types.${key}.handle.storage: C initialization and cleanup must remain explicit`,
				);
		}
		const isRecord = (type: CType): boolean => {
			const resolved = resolveCType(model, type);
			return resolved.kind === "record" && resolved.name === record.name;
		};
		let destroy: HandleType["destroy"];
		if (handle.destroy !== undefined) {
			const name =
				typeof handle.destroy === "string" ? handle.destroy : handle.destroy.function;
			const success =
				typeof handle.destroy === "string" ? undefined : handle.destroy.success;
			const declaration = model.functions.find((entry) => entry.name === name);
			if (declaration === undefined) {
				throw new FfiError(
					`types.${key}.handle.destroy: the headers declare no function '${name}'`,
				);
			}
			if (success !== undefined) {
				const result = resolveCType(model, declaration.returns);
				if (!["integer", "enum", "bool"].includes(result.kind))
					throw new FfiError(
						`types.${key}.handle.destroy.success: ${name} must return an integer or boolean`,
					);
				if (handle.collect === true)
					throw new FfiError(
						`types.${key}.handle.collect: cleanup that can fail requires explicit disposal`,
					);
				if (/^[A-Za-z_]\w*$/.test(success) && success !== "true" && success !== "false") {
					const macro = model.macros.find((entry) => entry.name === success);
					const knownMacro =
						macro !== undefined &&
						(typeof macro.value === "bigint" ||
							(typeof macro.value === "number" && Number.isInteger(macro.value)));
					if (
						!knownMacro &&
						![...model.enums.values()].some((entry) =>
							entry.constants.some((constant) => constant.name === success),
						)
					)
						throw new FfiError(
							`types.${key}.handle.destroy.success: '${success}' is not a known integer constant`,
						);
				}
			}
			const param = declaration.params[0];
			const resolved = param === undefined ? undefined : resolveCType(model, param.type);
			if (
				declaration.params.length === 1 &&
				param !== undefined &&
				isRecord(param.type)
			) {
				destroy = {
					name: declaration.name,
					takes: "value",
					...(success === undefined ? {} : { success }),
				};
			} else if (
				declaration.params.length === 1 &&
				resolved?.kind === "pointer" &&
				isRecord(resolved.to)
			) {
				destroy = {
					name: declaration.name,
					takes: "pointer",
					...(success === undefined ? {} : { success }),
				};
			} else {
				throw new FfiError(
					`types.${key}.handle.destroy: ${declaration.name} must take only a ${record.name}`,
				);
			}
		}
		const passedByValue = model.functions.some(
			(declaration) =>
				isRecord(declaration.returns) ||
				declaration.params.some((param) => isRecord(param.type)),
		);
		handles.set(record.name, {
			name: record.name,
			spelling: recordSpelling(model, record),
			representation:
				handle.storage !== "caller" && record.complete && passedByValue
					? "struct"
					: "pointer",
			...(handle.storage === "caller" ? { allocator: key } : {}),
			...(destroy === undefined ? {} : { destroy }),
			collect: handle.collect === true,
			views: [],
			family: record.name,
			...(record.doc === undefined ? {} : { doc: record.doc }),
		});
	}
	for (const [key, factsForType] of Object.entries(facts.types)) {
		if (factsForType.handle?.views === undefined) continue;
		const record = factRecord(model, key)!;
		const handle = handles.get(record.name)!;
		const views: Array<string> = [];
		for (const target of factsForType.handle.views) {
			const name = factRecord(model, target)?.name;
			const view = name === undefined ? undefined : handles.get(name);
			const at = `types.${key}.handle.views`;
			if (view === undefined)
				throw new FfiError(`${at}: '${target}' needs a handle fact`);
			if (handle.representation !== "pointer" || view.representation !== "pointer")
				throw new FfiError(`${at}: views require pointer handles`);
			if (view.name === handle.name || views.includes(view.name))
				throw new FfiError(`${at}: repeated or self view '${target}'`);
			views.push(view.name);
		}
		handles.set(record.name, { ...handle, views });
	}
	const closure = new Map<string, ReadonlyArray<string>>();
	const visiting = new Set<string>();
	const resolveViews = (name: string): ReadonlyArray<string> => {
		const known = closure.get(name);
		if (known !== undefined) return known;
		if (visiting.has(name))
			throw new FfiError(`types.${name}.handle.views: cyclic views`);
		visiting.add(name);
		const views = new Set<string>();
		for (const view of handles.get(name)!.views) {
			views.add(view);
			for (const ancestor of resolveViews(view)) views.add(ancestor);
		}
		visiting.delete(name);
		const result = [...views].sort();
		closure.set(name, result);
		return result;
	};
	for (const name of handles.keys()) resolveViews(name);
	const neighbors = new Map(
		[...handles].map(([name, handle]) => [name, new Set(handle.views)]),
	);
	for (const [name, handle] of handles)
		for (const view of handle.views) neighbors.get(view)!.add(name);
	const families = new Map<string, string>();
	for (const name of handles.keys()) {
		if (families.has(name)) continue;
		const component = new Set([name]);
		for (const member of component)
			for (const neighbor of neighbors.get(member)!) component.add(neighbor);
		const family = [...component].sort()[0]!;
		for (const member of component) families.set(member, family);
	}
	for (const [name, handle] of handles)
		handles.set(name, {
			...handle,
			views: closure.get(name)!,
			family: families.get(name)!,
		});
	return handles;
}

function functionFacts(model: CModel, facts: LibraryFacts): Map<string, FunctionFacts> {
	const result = new Map<string, FunctionFacts>();
	for (const [name, entry] of Object.entries(facts.functions)) {
		const declaration = model.functions.find((candidate) => candidate.name === name);
		if (declaration === undefined) {
			throw new FfiError(`functions.${name}: the headers declare no function '${name}'`);
		}
		const params = new Array<MaligatorFfiValueFacts | undefined>(
			declaration.params.length,
		);
		for (const [key, valueFacts] of Object.entries(entry.params ?? {})) {
			const index = /^\d+$/.test(key)
				? Number(key) - 1
				: declaration.params.findIndex((param) => param.name === key);
			if (index < 0 || index >= declaration.params.length) {
				throw new FfiError(
					`functions.${name}.params.${key}: ${name} has no such parameter`,
				);
			}
			params[index] = valueFacts;
		}
		result.set(name, { params, returns: entry.returns ?? NO_FACTS });
	}
	return result;
}

class Planner {
	readonly #model: CModel;
	readonly #accesses: ReturnType<typeof cRecordAccesses>;
	readonly records = new Map<string, MappedRecord>();
	readonly unions = new Map<string, MappedUnion>();
	readonly tagged = new Map<string, MappedTagged>();
	readonly #shapes = new Map<string, { alias: string; shape: MaligatorFfiShape }>();
	readonly #handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>;
	readonly #recordGaps = new Map<string, string>();
	readonly #pending = new Set<string>();
	#callableCount = 0;
	hasCallableCallbacks = false;

	constructor(
		model: CModel,
		handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>,
		facts: LibraryFacts,
	) {
		this.#model = model;
		this.#accesses = cRecordAccesses(model);
		this.#handles = handles;
		for (const [name, entry] of Object.entries(facts.types)) {
			if (entry.shape === undefined) continue;
			const type = model.records.has(name)
				? { kind: "record" as const, tag: model.records.get(name)!.tag, name }
				: model.typedefs.get(name)?.type;
			const resolved = type === undefined ? undefined : resolveCType(model, type);
			if (
				resolved?.kind !== "record" ||
				("member" in entry.shape && resolved.tag !== "union") ||
				entry.handle !== undefined ||
				handles.has(resolved.name)
			)
				throw new FfiError(
					`types.${name}.shape: member selection requires a union value; tagged shapes require a record value`,
				);
			if (this.#shapes.has(resolved.name))
				throw new FfiError(`types.${name}.shape: this record already has a shape fact`);
			this.#shapes.set(resolved.name, { alias: name, shape: entry.shape });
		}
	}

	#integer(name: string): Mapping {
		const size = this.#model.target.sizes[name];
		if (size === undefined) return { gap: `${name} has no size on this target` };
		const signed =
			name === "char" ? this.#model.target.charSigned : !name.startsWith("unsigned");
		const bits = size * 8;
		if (bits <= 32) return { value: { kind: "integer", bits, signed } };
		if (bits === 64) return { value: { kind: "bigint", bits, signed } };
		return { gap: `${bits}-bit integers have no JavaScript mapping` };
	}

	value(
		type: CType,
		position: Position,
		facts: MaligatorFfiValueFacts = NO_FACTS,
	): Mapping {
		const resolved = resolveCType(this.#model, type);
		if (
			facts.shape !== undefined &&
			resolved.kind !== "record" &&
			!(resolved.kind === "pointer" && facts.array !== undefined)
		)
			throw new FfiError("shape applies to record values or array elements");
		if (facts.fresh === true) {
			const target =
				resolved.kind === "pointer" ? resolveCType(this.#model, resolved.to) : undefined;
			const handle =
				target?.kind === "record" ? this.#handles.get(target.name) : undefined;
			if (
				position !== "return" ||
				handle?.representation !== "pointer" ||
				facts.array !== undefined ||
				facts.bytes !== undefined ||
				facts.string !== undefined
			)
				throw new FfiError("fresh applies only to pointer handle results");
		}
		switch (resolved.kind) {
			case "void":
				return position === "return"
					? { value: { kind: "undefined" } }
					: { gap: "void is not a value" };
			case "bool":
				return { value: { kind: "boolean" } };
			case "integer":
				return this.#integer(resolved.name);
			case "float": {
				const size = this.#model.target.sizes[resolved.name] ?? 0;
				return size > 0 && size <= 8
					? { value: { kind: "float", bits: size * 8 } }
					: { gap: `${resolved.name} is wider than a JavaScript number` };
			}
			case "enum": {
				const declaration = this.#model.enums.get(resolved.name);
				const underlying =
					declaration === undefined
						? undefined
						: resolveCType(this.#model, declaration.underlying);
				return underlying?.kind === "integer"
					? this.#integer(underlying.name)
					: this.#integer("int");
			}
			case "pointer":
				return this.#pointer(resolved, position, facts);
			case "array":
				if (position === "param") {
					return this.#pointer({ kind: "pointer", to: resolved.of }, position, facts);
				}
				return this.#array(resolved, position);
			case "record": {
				const handle = this.#handles.get(resolved.name);
				const declaration = this.#model.records.get(resolved.name);
				if (
					handle === undefined &&
					position === "param" &&
					declaration !== undefined &&
					cRecordHasConstMembers(this.#model, declaration)
				)
					return {
						gap: `${resolved.tag} ${resolved.name}: const members cannot be copied by value`,
					};
				if (
					facts.shape !== undefined &&
					(("member" in facts.shape && resolved.tag !== "union") || handle !== undefined)
				)
					throw new FfiError("shape.member applies to union values");
				if (handle === undefined) {
					const shape = this.#shapes.get(resolved.name);
					const selected = facts.shape ?? shape?.shape;
					const alias = facts.shape === undefined ? shape?.alias : undefined;
					const mapped =
						selected !== undefined && "tag" in selected
							? this.#tagged(resolved.name, selected, alias)
							: resolved.tag === "union"
								? this.#union(resolved.name, selected, alias)
								: this.#record(resolved.name, resolved.tag);
					if (
						position === "return" &&
						facts.borrowed !== true &&
						"value" in mapped &&
						this.#containsHandle(mapped.value)
					)
						return {
							gap: "resource-bearing value results require a pointer result interface",
						};
					return mapped;
				}
				if (handle.representation === "pointer") {
					return {
						gap: `${handle.name} handles are pointers, not structs passed by value`,
					};
				}
				const record = this.#model.records.get(resolved.name);
				if (
					position !== "return" &&
					record !== undefined &&
					cRecordHasConstMembers(this.#model, record)
				)
					return { gap: `${record.name}: const members cannot be copied by value` };
				return {
					value: {
						kind: "handle",
						name: handle.name,
						pass: "copy",
						nullable: false,
						owned: position === "return" && facts.borrowed !== true,
					},
				};
			}
			case "function":
				return { gap: "function types need a callback fact" };
			case "typedef":
			case "unsupported":
				return { gap: `unsupported type '${formatCDeclaration(type)}'` };
		}
	}

	#pointer(
		type: Extract<CType, { kind: "pointer" }>,
		position: Position,
		facts: MaligatorFfiValueFacts,
	): Mapping {
		const target = resolveCType(this.#model, type.to);
		const spelling = formatCDeclaration(type);
		const byteSized =
			target.kind === "integer" && this.#model.target.sizes[target.name] === 1;
		const free = facts.free === undefined ? {} : { free: facts.free };
		const nullable = position === "return" || facts.nullable === true;
		if (facts.bytes !== undefined) {
			if (!byteSized && target.kind !== "void") {
				throw new FfiError(`bytes applies to void and byte pointers, not ${spelling}`);
			}
			const writable =
				position === "param" && !("const" in target && target.const === true);
			return {
				value: {
					kind: "bytes",
					nullable,
					...free,
					...(writable ? { writable: true } : {}),
				},
			};
		}
		if (facts.array !== undefined) {
			// Elements of a borrowed array, such as a callback's, stay the library's.
			const element = this.value(type.to, position === "param" ? "param" : "return", {
				...(facts.borrowed === true ? { borrowed: true } : {}),
				...(facts.shape === undefined ? {} : { shape: facts.shape }),
			});
			if ("gap" in element) return { gap: `array element: ${element.gap}` };
			if (element.value.kind === "sequence" || element.value.kind === "bytes") {
				return { gap: "arrays of arrays need a fact" };
			}
			return {
				value: {
					kind: "sequence",
					of: element.value,
					element: type.to,
					nullable,
					...free,
				},
			};
		}
		const countedString = typeof facts.string === "object";
		if ((facts.string === true || countedString) && !byteSized) {
			throw new FfiError(`string applies to char pointers, not ${spelling}`);
		}
		if (
			facts.string === true ||
			countedString ||
			(target.kind === "integer" && target.name === "char" && target.const === true)
		) {
			if (position === "param" || position === "return")
				return {
					value: {
						kind: "string",
						nullable,
						...(countedString ? { counted: true as const } : {}),
						...(position === "return" ? free : {}),
					},
				};
		}
		const handle = target.kind === "record" ? this.#handles.get(target.name) : undefined;
		if (handle !== undefined && (position === "param" || position === "return")) {
			if (handle.representation === "pointer") {
				return {
					value: {
						kind: "handle",
						name: handle.name,
						pass: "pointer",
						nullable: position === "return" || facts.nullable === true,
						owned: position === "return" && facts.borrowed !== true,
						...(facts.fresh === true ? { fresh: true as const } : {}),
					},
				};
			}
			if (position === "param") {
				return {
					value: {
						kind: "handle",
						name: handle.name,
						pass: "reference",
						nullable: facts.nullable === true,
						owned: false,
					},
				};
			}
			return { gap: `a pointer into a ${handle.name} handle has no owner` };
		}
		// The record that holds the field names the fact it needs.
		if (position === "field") return { gap: `pointer field (${spelling})` };
		if (target.kind === "function") {
			return { gap: `function pointer (${spelling}) needs a callback fact` };
		}
		if (target.kind === "integer" && target.name === "char") {
			return {
				gap: `${spelling} needs a fact: an output buffer, an owned string, or bytes`,
			};
		}
		if (target.kind === "record" && !this.#model.records.get(target.name)?.complete) {
			return { gap: `opaque pointer (${spelling}) needs a handle fact` };
		}
		return {
			gap: `pointer (${spelling}) needs a fact: a handle, buffer, out parameter, or string`,
		};
	}

	#array(type: Extract<CType, { kind: "array" }>, position: Position): Mapping {
		if (type.length === undefined)
			return { gap: "an array without a length needs a fact" };
		const element = resolveCType(this.#model, type.of);
		if (element.kind === "integer" && element.name.endsWith("char")) {
			return { gap: `${formatCDeclaration(type)} needs a fact: a string or bytes` };
		}
		const mapped = this.value(type.of, position);
		return "gap" in mapped
			? { gap: `array element: ${mapped.gap}` }
			: { value: { kind: "array", of: mapped.value, length: type.length } };
	}

	#field(field: CField): Mapping {
		if (field.bitWidth === undefined)
			return this.value(field.integerType ?? field.type, "field");
		if (resolveCType(this.#model, field.type).kind === "bool" && field.bitWidth === 1)
			return { value: { kind: "boolean" } };
		if (field.integerType === undefined)
			return { gap: "cannot determine the bit-field's integer type" };
		if (field.bitWidth > 64)
			return { gap: "bit-fields wider than 64 bits have no JavaScript mapping" };
		const name = field.integerType.name;
		return {
			value: {
				kind: field.bitWidth <= 32 ? "integer" : "bigint",
				bits: field.bitWidth,
				signed:
					name === "char" ? this.#model.target.charSigned : !name.startsWith("unsigned"),
			},
		};
	}

	#union(
		name: string,
		shape: Extract<MaligatorFfiShape, { member: string }> | undefined,
		alias?: string,
	): Mapping {
		if (shape === undefined)
			return { gap: `union ${name}: select an active member with a shape fact` };
		const record = this.#model.records.get(name);
		if (record === undefined || !record.complete)
			return { gap: `union ${name}: incomplete type` };
		if (cRecordHasConstMembers(this.#model, record))
			return { gap: `union ${name}: const members cannot be copied by value` };
		const field = [...promotedCFields(this.#model, record)].find(
			(field) => field.name === shape.member,
		);
		if (field === undefined)
			throw new FfiError(`union ${name}: no member '${shape.member}'`);
		const identity = createHash("sha256")
			.update(
				JSON.stringify([
					this.#accesses.get(name)?.owner,
					this.#accesses.get(name)?.path,
					shape,
					alias,
				]),
			)
			.digest("hex")
			.slice(0, 16);
		const mappedName = `union_${identity}`;
		if (this.#pending.has(mappedName))
			return { gap: `union ${name}: recursive value shape` };
		this.#pending.add(mappedName);
		let mapped: Mapping;
		try {
			mapped = this.#field(field);
		} finally {
			this.#pending.delete(mappedName);
		}
		if ("gap" in mapped) return { gap: `union ${name}.${shape.member}: ${mapped.gap}` };
		if (mapped.value.kind === "handle")
			return { gap: `union ${name}: a selected handle needs a pointer interface` };
		const spelling = this.#accesses.get(name)?.spelling;
		if (spelling === undefined)
			return { gap: `union ${name}: the C type has no accessible spelling` };
		this.unions.set(mappedName, {
			name: mappedName,
			spelling,
			record,
			member: {
				name: shape.member,
				type: field.integerType ?? field.type,
				value: mapped.value,
				...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
			},
			...(alias === undefined ? {} : { alias }),
		});
		return {
			value: {
				kind: "union",
				name: mappedName,
				of: mapped.value,
				...(alias === undefined ? {} : { alias }),
			},
		};
	}

	#tagged(
		name: string,
		shape: Extract<MaligatorFfiShape, { tag: string }>,
		alias?: string,
	): Mapping {
		const record = this.#model.records.get(name);
		const access = this.#accesses.get(name);
		if (record === undefined || !record.complete || access?.spelling === undefined)
			return { gap: `tagged ${name}: the complete C type needs an accessible spelling` };
		if (cRecordHasConstMembers(this.#model, record))
			return { gap: `tagged ${name}: const members cannot be copied by value` };
		const identity = createHash("sha256")
			.update(JSON.stringify([access.owner, access.path, shape, alias]))
			.digest("hex")
			.slice(0, 16);
		const mappedName = `tagged_${identity}`;
		const known = this.tagged.get(mappedName);
		const asValue = (mapped: MappedTagged): JsValue => ({
			kind: "tagged",
			name: mapped.name,
			tag: mapped.tag.name,
			cases: mapped.cases.map((entry) => ({
				literal: entry.literal,
				value: { kind: "record", name: entry.record.name },
			})),
			...(mapped.alias === undefined ? {} : { alias: mapped.alias }),
		});
		if (known !== undefined) return { value: asValue(known) };
		if (this.#pending.has(mappedName))
			return { gap: `tagged ${name}: recursive value shape` };
		const tagPath = resolveCFieldPath(this.#model, record, [shape.tag]);
		const tagField = tagPath?.at(-1)?.field;
		if (tagField === undefined)
			throw new FfiError(`tagged ${name}: no discriminator '${shape.tag}'`);
		const tagMapping = this.#field(tagField);
		if (
			!("value" in tagMapping) ||
			!["integer", "bigint", "boolean"].includes(tagMapping.value.kind)
		)
			throw new FfiError(
				`tagged ${name}.${shape.tag}: the discriminator must be an integer, enum, or boolean`,
			);
		const tag = tagMapping.value;
		if (tag.kind !== "integer" && tag.kind !== "bigint" && tag.kind !== "boolean")
			throw new Error("invalid tag mapping");
		const bits = tag.kind === "boolean" ? 1 : tag.bits;
		const signed = tag.kind === "boolean" ? false : tag.signed;
		const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
		const maximum = (1n << BigInt(bits - Number(signed))) - 1n;
		const seen = new Set<bigint>();
		const cases: Array<MappedTagged["cases"][number]> = [];
		this.#pending.add(mappedName);
		try {
			for (const [key, selection] of Object.entries(shape.cases)) {
				const enumeration = [...this.#model.enums.values()]
					.flatMap((entry) => entry.constants)
					.find((entry) => entry.name === key);
				const definition = [...this.#model.macros, ...this.#model.untypedMacros].find(
					(entry) => entry.name === key,
				);
				const macro = this.#model.macros.find((entry) => entry.name === key);
				const constant =
					definition === undefined
						? enumeration?.value
						: definition.contextual !== true && definition.parameters === undefined
							? macro?.value
							: undefined;
				const value = /^(?:0|-?[1-9]\d*)$/.test(key)
					? BigInt(key)
					: typeof constant === "bigint"
						? constant
						: typeof constant === "number" && Number.isSafeInteger(constant)
							? BigInt(constant)
							: undefined;
				if (value === undefined)
					throw new FfiError(`tagged ${name}: '${key}' is not a known integer constant`);
				if (value < minimum || value > maximum)
					throw new FfiError(`tagged ${name}: '${key}' does not fit the discriminator`);
				if (seen.has(value))
					throw new FfiError(`tagged ${name}: duplicate discriminator value '${key}'`);
				seen.add(value);
				const choices = new Map<string, number>();
				const selected = new Set<string>();
				for (const selector of selection) {
					if (selected.has(selector))
						throw new FfiError(`tagged ${name}: duplicate selection '${selector}'`);
					selected.add(selector);
					const path = resolveCFieldPath(this.#model, record, selector.split("."));
					if (
						path === undefined ||
						!path.some((step) => step.record.tag === "union") ||
						path.at(-1)?.record.tag !== "union"
					)
						throw new FfiError(
							`tagged ${name}: '${selector}' must name an active union member`,
						);
					const route: Array<number> = [];
					for (const step of path) {
						if (step.record.tag === "union") {
							const at = route.join(".");
							const prior = choices.get(at);
							if (prior !== undefined && prior !== step.index)
								throw new FfiError(
									`tagged ${name}: conflicting union selections in '${key}'`,
								);
							choices.set(at, step.index);
						}
						route.push(step.index);
					}
				}
				const view = this.#caseRecord(
					record,
					[],
					choices,
					tagPath!.map((step) => step.index).join("."),
					`${identity}_${cases.length}`,
				);
				if ("gap" in view) return view;
				if (view.value.kind !== "record")
					throw new Error("tagged case without record view");
				cases.push({
					expression:
						value < 0n ? `(-INT64_C(${-value - 1n}) - INT64_C(1))` : `UINT64_C(${value})`,
					literal:
						tag.kind === "bigint"
							? `${value}n`
							: tag.kind === "boolean"
								? String(value !== 0n)
								: String(value),
					selection,
					record: this.records.get(view.value.name)!,
				});
			}
		} finally {
			this.#pending.delete(mappedName);
		}
		const mapped: MappedTagged = {
			name: mappedName,
			spelling: access.spelling,
			record,
			tag: { name: shape.tag, type: tagField.integerType ?? tagField.type, value: tag },
			cases,
			...(alias === undefined ? {} : { alias }),
		};
		this.tagged.set(mappedName, mapped);
		return { value: asValue(mapped) };
	}

	#caseRecord(
		record: CRecord,
		route: ReadonlyArray<number>,
		choices: ReadonlyMap<string, number>,
		omitted: string,
		identity: string,
	): Mapping {
		const spelling = this.#accesses.get(record.name)?.spelling;
		if (spelling === undefined)
			return { gap: `tagged ${record.name}: the C type has no accessible spelling` };
		const mappedName = `MaligatorFfiCase_${identity}_${route.join("_") || "root"}`;
		const fields: Array<MappedField> = [];
		const append = (
			current: CRecord,
			path: ReadonlyArray<number>,
		): string | undefined => {
			const choice = choices.get(path.join("."));
			for (const [index, field] of current.fields.entries()) {
				if (current.tag === "union" && index !== choice) continue;
				const next = [...path, index];
				if (
					next.join(".") === omitted ||
					(field.name === undefined && field.bitWidth !== undefined)
				)
					continue;
				const type = resolveCType(this.#model, field.type);
				const nested =
					type.kind === "record" ? this.#model.records.get(type.name) : undefined;
				if (field.name === undefined) {
					if (nested === undefined) return "unsupported anonymous member";
					const failure = append(nested, next);
					if (failure !== undefined) return failure;
					continue;
				}
				// The outer discriminator owns these fields; defaults cannot activate omitted storage.
				if (
					current.tag === "struct" &&
					nested?.tag === "union" &&
					!choices.has(next.join("."))
				)
					continue;
				const mapped = this.#caseField(field, next, choices, omitted, identity);
				if (mapped === undefined) continue;
				if ("gap" in mapped) return `field '${field.name}': ${mapped.gap}`;
				if (mapped.value.kind === "handle")
					return `field '${field.name}' needs a pointer interface`;
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
				});
			}
			return undefined;
		};
		const failure = append(record, route);
		if (failure !== undefined) return { gap: `tagged ${record.name}: ${failure}` };
		this.records.set(mappedName, {
			name: mappedName,
			spelling,
			record,
			fields,
			private: true,
		});
		return { value: { kind: "record", name: mappedName } };
	}

	#caseField(
		field: CField,
		route: ReadonlyArray<number>,
		choices: ReadonlyMap<string, number>,
		omitted: string,
		identity: string,
	): Mapping | undefined {
		const type = resolveCType(this.#model, field.type);
		const record =
			type.kind === "record" ? this.#model.records.get(type.name) : undefined;
		if (record === undefined) return this.#field(field);
		const prefix = route.join(".");
		const selectedBelow = [...choices.keys()].some(
			(key) => key === prefix || key.startsWith(`${prefix}.`),
		);
		if (this.#handles.has(record.name))
			return selectedBelow
				? { gap: `union selectors cannot traverse ${record.name} handles` }
				: this.#field(field);
		if (this.#shapes.has(record.name) && !selectedBelow) return this.#field(field);
		if (record.tag === "struct")
			return this.#caseRecord(record, route, choices, omitted, identity);
		const selected = choices.get(prefix);
		if (selected === undefined) return undefined;
		const member = record.fields[selected]!;
		if (member.name === undefined)
			return this.#caseRecord(record, route, choices, omitted, identity);
		const mapping = this.#caseField(
			member,
			[...route, selected],
			choices,
			omitted,
			identity,
		);
		if (mapping === undefined)
			return { gap: `union ${record.name}: select its active member` };
		if ("gap" in mapping) return mapping;
		if (mapping.value.kind === "handle")
			return { gap: `union ${record.name}: a selected handle needs a pointer interface` };
		const spelling = this.#accesses.get(record.name)?.spelling;
		if (spelling === undefined)
			return { gap: `union ${record.name}: the C type has no accessible spelling` };
		const name = `case_union_${identity}_${route.join("_")}`;
		this.unions.set(name, {
			name,
			spelling,
			record,
			member: {
				name: member.name,
				type: member.integerType ?? member.type,
				value: mapping.value,
				...(member.bitWidth === undefined ? {} : { bitWidth: member.bitWidth }),
			},
		});
		return { value: { kind: "union", name, of: mapping.value } };
	}

	#record(name: string, tag: "struct" | "union"): Mapping {
		const access = this.#accesses.get(name);
		const anonymous = !/^[A-Za-z_]\w*$/.test(name);
		const mappedName = anonymous
			? `MaligatorFfiAnonymous_${createHash("sha256")
					.update(JSON.stringify([access?.owner, access?.path]))
					.digest("hex")
					.slice(0, 16)}`
			: name;
		const known = this.records.get(mappedName);
		if (known !== undefined) return { value: { kind: "record", name: mappedName } };
		const failure = this.#recordGaps.get(name);
		if (failure !== undefined) return { gap: failure };
		const gap = (reason: string): Mapping => {
			const message = `${tag} ${name}: ${reason}`;
			this.#recordGaps.set(name, message);
			return { gap: message };
		};
		const record = this.#model.records.get(name);
		if (tag === "union" || record?.tag === "union") return gap("unions need a fact");
		if (record === undefined || !record.complete)
			return gap("opaque structs cannot pass by value");
		if (access?.spelling === undefined)
			return gap("the C type has no accessible spelling");
		if (this.#pending.has(name)) return gap("recursive struct");
		this.#pending.add(name);
		const fields: Array<MappedField> = [];
		try {
			for (const field of promotedCFields(this.#model, record)) {
				if (field.name === undefined && field.bitWidth !== undefined) continue;
				if (field.name === undefined) return gap("anonymous members need a fact");
				const mapped = this.#field(field);
				if ("gap" in mapped) {
					// A struct that holds a pointer owns or borrows memory, so it crosses as a handle.
					return resolveCType(this.#model, field.type).kind === "pointer"
						? gap(
								`field '${field.name}' is a pointer (${formatCDeclaration(field.type)}), so ${name} needs a handle fact`,
							)
						: gap(`field '${field.name}': ${mapped.gap}`);
				}
				if (mapped.value.kind === "handle") {
					return gap(
						`field '${field.name}' holds a ${mapped.value.name} handle, so ${name} needs a handle fact too`,
					);
				}
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		} finally {
			this.#pending.delete(name);
		}
		this.records.set(mappedName, {
			name: mappedName,
			spelling: access.spelling,
			record,
			fields,
			...(anonymous ? { private: true as const } : {}),
		});
		return { value: { kind: "record", name: mappedName } };
	}

	/** The value fields a struct handle exposes; others stay hidden behind the handle. */
	handleFields(
		record: CRecord,
		managed: ReadonlyArray<ManagedField>,
		handle: Omit<HandleType, "fields" | "managedFields">,
		facts: Readonly<Record<string, MaligatorFfiFieldFacts>>,
		exposeValues: boolean,
	): Array<MappedField> {
		const fields: Array<MappedField> = [];
		const members = [...promotedCFields(this.#model, record)];
		for (const name of Object.keys(facts))
			if (!members.some((field) => field.name === name))
				throw new FfiError(
					`types.${record.name}.fields.${name}: the handle has no such field`,
				);
		for (const field of members) {
			if (field.name === undefined || managed.some((entry) => entry.name === field.name))
				continue;
			const fact = facts[field.name];
			if (!exposeValues && fact?.callable === undefined) continue;
			const mapped =
				fact?.callable === undefined
					? this.#field(field)
					: this.#callable(
							field.type,
							{ callable: fact.callable },
							{
								targetType: `__typeof__((0, ((${handle.spelling} *) nullptr)->${field.name}))`,
								path: `types.${record.name}.fields.${field.name}`,
								site: `${record.name}.${field.name}`,
								location: record.location,
								owner: handle.name,
							},
						);
			if (fact?.callable !== undefined && "gap" in mapped)
				throw new FfiError(`types.${record.name}.fields.${field.name}: ${mapped.gap}`);
			// Accessors return single values; array fields stay behind the handle.
			if (
				"value" in mapped &&
				mapped.value.kind !== "array" &&
				!this.#containsHandle(mapped.value)
			) {
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		}
		return fields;
	}

	managedFields(
		record: CRecord,
		facts: Record<string, MaligatorFfiFieldFacts> = {},
	): Array<ManagedField> {
		const result: Array<ManagedField> = [];
		const counts = new Set<string>();
		const fields = [...promotedCFields(this.#model, record)];
		for (const [name, fact] of Object.entries(facts)) {
			if (fact.callable !== undefined) continue;
			const at = `types.${record.name}.fields.${name}`;
			const kind = fact.string === undefined ? "bytes" : "string";
			const counted = fact.string ?? fact.bytes;
			const field = fields.find((entry) => entry.name === name);
			const count = fields.find((entry) => entry.name === counted.length);
			const pointer =
				field === undefined ? undefined : resolveCType(this.#model, field.type);
			const integer =
				count === undefined ? undefined : resolveCType(this.#model, count.type);
			const target =
				pointer?.kind === "pointer" ? resolveCType(this.#model, pointer.to) : undefined;
			if (
				field === undefined ||
				pointer?.kind !== "pointer" ||
				pointer.const === true ||
				(!(kind === "bytes" && target?.kind === "void") &&
					!(target?.kind === "integer" && this.#model.target.sizes[target.name] === 1))
			)
				throw new FfiError(
					`${at}: ${kind} requires a writable ${kind === "bytes" ? "byte or void" : "byte"} pointer field`,
				);
			if (
				count === undefined ||
				integer?.kind !== "integer" ||
				integer.const === true ||
				count.bitWidth !== undefined
			)
				throw new FfiError(
					`${at}.${kind}.length: '${counted.length}' must be a writable integer field`,
				);
			if (counts.has(counted.length))
				throw new FfiError(
					`${at}.${kind}.length: '${counted.length}' already counts another field`,
				);
			const mapped = this.#integer(integer.name);
			if (
				!("value" in mapped) ||
				(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
			)
				throw new FfiError(`${at}.${kind}.length: unsupported integer width`);
			counts.add(counted.length);
			result.push({
				kind,
				name,
				type: field.type,
				count: counted.length,
				countType: count.type,
				bits: mapped.value.bits,
				signed: mapped.value.signed,
				writable:
					fact.bytes?.writable ??
					!(target !== undefined && "const" in target && target.const === true),
				...(field.doc === undefined ? {} : { doc: field.doc }),
			});
		}
		return result;
	}

	/**
	 * A callback parameter: C passes each argument to the JavaScript function as it
	 * would a result, except handles, which the library keeps owning.
	 */
	#containsHandle(value: JsValue): boolean {
		if (value.kind === "handle") return true;
		if (value.kind === "tagged")
			return value.cases.some((entry) => this.#containsHandle(entry.value));
		if (value.kind === "array" || value.kind === "sequence" || value.kind === "union")
			return this.#containsHandle(value.of);
		return (
			value.kind === "record" &&
			this.records
				.get(value.name)!
				.fields.some((field) => this.#containsHandle(field.value))
		);
	}

	#callback(
		type: CType,
		nullable: boolean,
		callback: MaligatorFfiCallback,
		at: string,
	): Mapping {
		const facts = callback.params ?? {};
		const kept =
			callback.release !== undefined ||
			callback.replaced === true ||
			callback.closes !== undefined;
		const queued =
			callback.queued === true ||
			callback.queued === "wait" ||
			callback.closes !== undefined;
		// Whether the callback receives its user data as a `void *` parameter.
		const routed = callback.data !== undefined && callback.lookup === undefined;
		const target =
			type.kind === "pointer" ? resolveCType(this.#model, type.to) : undefined;
		if (target?.kind !== "function" || target.variadic) {
			throw new FfiError(
				`${at}.callback: ${formatCDeclaration(type)} is not a function pointer`,
			);
		}
		const factsAt = (index: number): MaligatorFfiValueFacts | undefined =>
			facts[String(index + 1)];
		const resultFacts = callback.returns;
		if (resultFacts !== undefined && callback.closes !== undefined)
			throw new FfiError(
				`${at}.callback.returns: a close completion ends its registration before returning a pointer result`,
			);
		if (resultFacts?.lifetime === "call" && kept)
			throw new FfiError(
				`${at}.callback.returns: call lifetime needs a call-scoped callback`,
			);
		if (resultFacts?.lifetime === "registration" && !kept)
			throw new FfiError(
				`${at}.callback.returns: registration lifetime needs a retained callback`,
			);
		const resultCounted = resultFacts === undefined ? undefined : valueCount(resultFacts);
		let resultCount: Extract<JsValue, { kind: "callback" }>["resultCount"];
		if (resultCounted !== undefined) {
			const reference = resultCounted.count.length;
			const param = /^[1-9]\d*$/.test(reference) ? Number(reference) - 1 : -1;
			const type =
				param < 0 || param >= target.params.length
					? undefined
					: resolveCType(this.#model, target.params[param]!);
			const integer =
				type?.kind === "pointer" ? resolveCType(this.#model, type.to) : undefined;
			const mapped =
				integer?.kind === "integer" ? this.#integer(integer.name) : undefined;
			if (
				integer?.kind !== "integer" ||
				integer.const === true ||
				mapped === undefined ||
				!("value" in mapped) ||
				(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
			)
				throw new FfiError(
					`${at}.callback.returns: length needs a writable supported integer pointer by 1-based position`,
				);
			resultCount = { param, bits: mapped.value.bits, signed: mapped.value.signed };
		}
		for (const key of Object.keys(facts)) {
			const position = Number(key) - 1;
			const stated = facts[key]!;
			if (position >= target.params.length) {
				throw new FfiError(
					`${at}.callback.params.${key}: the callback has no such parameter`,
				);
			}
			const unsupported = Object.keys(stated).filter(
				(name) => !["string", "bytes", "array", "nullable", "shape"].includes(name),
			);
			if (unsupported.length > 0) {
				throw new FfiError(
					`${at}.callback.params.${key}: ${unsupported.join(", ")} does not apply to callback parameters`,
				);
			}
		}
		// Counts belong to their converted argument and stay hidden from JavaScript.
		const counts = new Array<number | undefined>(target.params.length);
		const counters = new Set<number>();
		target.params.forEach((_, index) => {
			const counted = valueCount(factsAt(index) ?? NO_FACTS)?.count;
			if (counted === undefined) return;
			const count = /^[1-9]\d*$/.test(counted.length) ? Number(counted.length) - 1 : -1;
			const countType =
				count < 0 || count >= target.params.length
					? undefined
					: resolveCType(this.#model, target.params[count]!);
			if (countType?.kind === "integer" && "gap" in this.#integer(countType.name))
				throw new FfiError(
					`${at}.callback.params.${String(index + 1)}: a callback count needs a supported integer of at most 64 bits`,
				);
			if (countType?.kind !== "integer" || count === index || counters.has(count)) {
				throw new FfiError(
					`${at}.callback.params.${String(index + 1)}: length '${counted.length}' is not another integer parameter's 1-based position`,
				);
			}
			counts[index] = count;
			counters.add(count);
		});
		if (resultCount !== undefined && counters.has(resultCount.param))
			throw new FfiError(
				`${at}.callback.returns: the result count already counts an argument`,
			);
		const params: Array<JsValue | "data" | "count"> = [];
		for (const [index, param] of target.params.entries()) {
			if (counters.has(index) || resultCount?.param === index) {
				params.push("count");
				continue;
			}
			const stated = factsAt(index);
			const resolved = resolveCType(this.#model, param);
			if (
				routed &&
				stated === undefined &&
				resolved.kind === "pointer" &&
				resolveCType(this.#model, resolved.to).kind === "void" &&
				!params.includes("data")
			) {
				params.push("data");
				continue;
			}
			const mapped = this.value(param, "return", { ...stated, borrowed: true });
			if ("gap" in mapped) {
				return { gap: `callback parameter ${String(index + 1)}: ${mapped.gap}` };
			}
			params.push(mapped.value);
		}
		if (routed && !params.includes("data")) {
			throw new FfiError(`${at}.callback: the callback takes no void * for its data`);
		}
		const lookup =
			callback.lookup === undefined
				? undefined
				: this.#lookup(target, callback.lookup, `${at}.callback.lookup`);
		if (queued) {
			if (
				callback.queued !== "wait" &&
				params.some(
					(param) =>
						typeof param === "object" &&
						this.#containsHandle(param) &&
						!(callback.closes !== undefined && param.kind === "handle"),
				)
			)
				throw new FfiError(
					`${at}.callback.queued: resource-bearing values require a waiting callback`,
				);
			// A queued call outlives the C caller's arguments, so it gets copies of values.
			const copyable = params.every(
				(param) =>
					typeof param !== "object" ||
					[
						"boolean",
						"integer",
						"float",
						"bigint",
						"string",
						"bytes",
						"record",
						"union",
						"tagged",
						...(callback.closes !== undefined || callback.queued === "wait"
							? ["handle"]
							: []),
					].includes(param.kind),
			);
			if (
				(callback.queued !== "wait" &&
					resolveCType(this.#model, target.returns).kind !== "void") ||
				!copyable ||
				(lookup !== undefined && callback.closes === undefined)
			) {
				throw new FfiError(
					`${at}.callback.queued: a queued callback returns nothing, takes values, strings, buffers, and structs, and has no lookup`,
				);
			}
		}
		const returned = resolveCType(this.#model, target.returns);
		let returns: JsValue = { kind: "undefined" };
		if (returned.kind !== "void") {
			const mapped = this.value(target.returns, "param", resultFacts);
			if ("gap" in mapped) return { gap: `callback result: ${mapped.gap}` };
			if (mapped.value.kind !== "handle" && this.#containsHandle(mapped.value))
				return {
					gap: "compound callback results containing handles require a pointer result interface",
				};
			if (mapped.value.kind === "handle") {
				if (mapped.value.pass !== "pointer")
					return { gap: "a callback handle result needs a pointer representation" };
			}
			if (
				(mapped.value.kind === "string" ||
					mapped.value.kind === "bytes" ||
					mapped.value.kind === "handle") &&
				resultFacts?.lifetime === undefined
			) {
				return { gap: "a callback that returns a pointer needs a lifetime fact" };
			}
			if (
				resultFacts?.lifetime !== undefined &&
				mapped.value.kind !== "string" &&
				mapped.value.kind !== "bytes" &&
				mapped.value.kind !== "handle"
			)
				throw new FfiError(`${at}.callback.returns: lifetime applies to pointer results`);
			returns = mapped.value;
		} else if (resultFacts !== undefined)
			throw new FfiError(`${at}.callback.returns: lifetime applies to pointer results`);
		return {
			value: {
				kind: "callback",
				type: target,
				params,
				counts,
				returns,
				...(resultFacts?.lifetime === undefined
					? {}
					: { returnLifetime: resultFacts.lifetime }),
				...(resultCount === undefined ? {} : { resultCount }),
				nullable,
				kept,
				...(lookup === undefined ? {} : { lookup }),
				...(queued
					? { queued: callback.queued === "wait" ? ("wait" as const) : (true as const) }
					: {}),
			},
		};
	}

	/**
	 * Check that a lookup names a function that takes the callback parameter at
	 * `param` and returns `void *`.
	 */
	#lookup(
		callback: Extract<CType, { kind: "function" }>,
		lookup: { readonly function: string; readonly param: string },
		at: string,
	): { readonly function: string; readonly param: number } {
		const declaration = this.#model.functions.find(
			(entry) => entry.name === lookup.function,
		);
		const param = Number(lookup.param) - 1;
		const takes = declaration?.params[0]?.type;
		const passed = callback.params[param];
		const result =
			declaration === undefined
				? undefined
				: resolveCType(this.#model, declaration.returns);
		// A `const` pointee on either side converts implicitly in C.
		const spelling = (type: CType): string =>
			formatCDeclaration(resolveCType(this.#model, type)).replaceAll("const ", "");
		if (
			declaration?.params.length !== 1 ||
			takes === undefined ||
			passed === undefined ||
			result?.kind !== "pointer" ||
			resolveCType(this.#model, result.to).kind !== "void" ||
			spelling(takes) !== spelling(passed)
		) {
			throw new FfiError(
				`${at}: '${lookup.function}' does not return a void * from callback parameter ${lookup.param}`,
			);
		}
		return { function: lookup.function, param };
	}

	/**
	 * Key a function's replaced callback by the handle its first parameter passes, so
	 * each handle keeps its own, and without user data find the callback parameter that
	 * passes the handle back. Returns the callback's C parameter position.
	 */
	#replaced(
		declaration: CFunction,
		factsAt: (index: number) => MaligatorFfiValueFacts,
		args: ReadonlyArray<Argument>,
		params: Array<MappedParameter>,
		where: (at: string) => string,
	): number | undefined {
		const indexes = declaration.params.flatMap((_, index) =>
			factsAt(index).callback?.replaced === true ? [index] : [],
		);
		const index = indexes[0];
		if (index === undefined) return undefined;
		const at = where(
			`params.${declaration.params[index]!.name ?? String(index + 1)}.callback`,
		);
		if (indexes.length > 1) {
			throw new FfiError(`${at}: a function takes at most one replaced callback`);
		}
		const entry = args[index];
		if (entry?.kind !== "input") return index;
		const param = params[entry.param]!;
		if (param.value.kind !== "callback") return index;
		const first = args[0];
		const handle = first?.kind === "input" ? params[first.param]!.value : undefined;
		const key =
			index > 0 && handle?.kind === "handle" && handle.pass === "pointer"
				? handle
				: undefined;
		const keyParam = param.value.params.findIndex(
			(value) =>
				typeof value === "object" &&
				value.kind === "handle" &&
				key !== undefined &&
				this.#handles.get(value.name)?.family === this.#handles.get(key.name)?.family,
		);
		if (
			key !== undefined &&
			keyParam < 0 &&
			!param.value.params.includes("data") &&
			param.value.lookup === undefined
		) {
			throw new FfiError(
				`${at}: a replaced callback without data needs a parameter that passes its ${key.name} back`,
			);
		}
		params[entry.param] = {
			...param,
			value: {
				...param.value,
				replaced:
					key === undefined ? {} : { key: 0, ...(keyParam < 0 ? {} : { keyParam }) },
			},
		};
		return index;
	}

	#closingCallback(
		declaration: CFunction,
		factsAt: (index: number) => MaligatorFfiValueFacts,
		args: ReadonlyArray<Argument>,
		params: Array<MappedParameter>,
		where: (at: string) => string,
	): void {
		const indexes = declaration.params.flatMap((_, index) =>
			factsAt(index).callback?.closes === undefined ? [] : [index],
		);
		if (indexes.length === 0) return;
		if (indexes.length > 1)
			throw new FfiError(
				`${where("params")}: a function takes at most one close completion`,
			);
		const index = indexes[0]!;
		const at = where(
			`params.${declaration.params[index]!.name ?? String(index + 1)}.callback.closes`,
		);
		const reference = factsAt(index).callback!.closes!;
		const key = declaration.params.findIndex(
			(param, position) => param.name === reference || String(position + 1) === reference,
		);
		const input = args[key];
		const handle = input?.kind === "input" ? params[input.param]!.value : undefined;
		const entry = args[index];
		if (entry?.kind !== "input") return;
		const param = params[entry.param]!;
		if (param.value.kind !== "callback") return;
		if (
			input?.kind !== "input" ||
			handle?.kind !== "handle" ||
			handle.pass !== "pointer" ||
			handle.nullable ||
			param.value.nullable
		)
			throw new FfiError(
				`${at}: a close completion needs a nonnullable pointer handle input and callback`,
			);
		if (resolveCType(this.#model, declaration.returns).kind !== "void")
			throw new FfiError(`${at}: a close registration returns void`);
		const handles = param.value.params.flatMap((value, position) =>
			typeof value === "object" && value.kind === "handle" ? [{ value, position }] : [],
		);
		if (
			handles.length > 1 ||
			handles.some(
				({ value }) =>
					value.pass !== "pointer" ||
					this.#handles.get(value.name)?.family !==
						this.#handles.get(handle.name)?.family,
			)
		)
			throw new FfiError(
				`${at}: only the closing handle may be a completion pointer argument`,
			);
		const keyParam = handles[0]?.position;
		if (
			keyParam !== undefined &&
			factsAt(index).callback?.params?.[String(keyParam + 1)]?.nullable === true
		)
			throw new FfiError(`${at}: the completion's closing handle is nonnullable`);
		if (
			keyParam === undefined &&
			!param.value.params.includes("data") &&
			param.value.lookup === undefined
		)
			throw new FfiError(
				`${at}: a close completion needs its handle or user data to route it`,
			);
		params[entry.param] = {
			...param,
			value: {
				...param.value,
				params: param.value.params.map((value, position) =>
					position === keyParam && typeof value === "object" && value.kind === "handle"
						? { ...value, nullable: false }
						: value,
				),
				closes: {
					param: input.param,
					key,
					...(keyParam === undefined ? {} : { keyParam }),
				},
			},
		};
	}

	/**
	 * Whether a setter's result is the callback it replaced, or that callback's user
	 * data, which only the binding could interpret.
	 */
	#returnsPrevious(declaration: CFunction, callback: number, data: boolean): boolean {
		const result = resolveCType(this.#model, declaration.returns);
		if (result.kind !== "pointer") return false;
		if (data && resolveCType(this.#model, result.to).kind === "void") return true;
		return (
			formatCDeclaration(result) ===
			formatCDeclaration(resolveCType(this.#model, declaration.params[callback]!.type))
		);
	}

	/**
	 * Check that a `free` fact releases a copied result and names a function that
	 * takes the pointer to release.
	 */
	#free(name: string | undefined, value: JsValue, at: string): void {
		if (name === undefined) return;
		if (value.kind !== "string" && value.kind !== "bytes" && value.kind !== "sequence") {
			throw new FfiError(`${at}.free: free applies to string, buffer, and array results`);
		}
		const declaration = this.#model.functions.find((entry) => entry.name === name);
		const param = declaration?.params[0];
		if (
			declaration === undefined ||
			declaration.params.length !== 1 ||
			param === undefined ||
			resolveCType(this.#model, param.type).kind !== "pointer"
		) {
			throw new FfiError(
				`${at}.free: '${name}' is not a function that takes one pointer`,
			);
		}
	}

	#callable(
		type: CType,
		facts: MaligatorFfiValueFacts,
		context: {
			readonly targetType: string;
			readonly path: string;
			readonly site: string;
			readonly location: CFunction["location"];
			readonly owner?: string;
		},
	): Mapping {
		const at = `${context.path}.callable`;
		const callable = facts.callable!;
		const pointer = resolveCType(this.#model, type);
		const target =
			pointer.kind === "pointer" ? resolveCType(this.#model, pointer.to) : undefined;
		if (target?.kind !== "function")
			throw new FfiError(`${at}: callable requires a function pointer`);
		if (Object.keys(facts).some((key) => key !== "callable" && key !== "nullable"))
			throw new FfiError(`${at}: callable cannot accompany another value representation`);
		if (callable.lifetime === "owner" && context.owner === undefined)
			throw new FfiError(
				`${at}.lifetime: owner lifetime requires a function-table field`,
			);
		if (target.variadic)
			return { gap: "a callable function pointer needs a fixed signature" };
		const params: Array<MaligatorFfiValueFacts | undefined> = [];
		for (const [key, value] of Object.entries(callable.params ?? {})) {
			const index = Number(key) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= target.params.length)
				throw new FfiError(
					`${at}.params.${key}: the function pointer has no such parameter`,
				);
			params[index] = value;
		}
		const name = `mal_callable_${this.#callableCount++}`;
		const signature = this.function(
			{
				name,
				returns: target.returns,
				params: target.params.map((type, index) => ({ name: `arg${index + 1}`, type })),
				variadic: false,
				inline: false,
				attributes: [],
				location: context.location,
			},
			{ params, returns: callable.returns ?? NO_FACTS },
			undefined,
			{
				targetType: context.targetType,
				path: at,
				site: context.site,
				...(callable.lifetime === "owner" ? { owner: context.owner! } : {}),
			},
		);
		if ("gaps" in signature)
			return {
				gap: `callable signature: ${signature.gaps.map((gap) => `${gap.at}: ${gap.reason}`).join("; ")}`,
			};
		if (signature.params.some(({ value }) => value.kind === "callback"))
			this.hasCallableCallbacks = true;
		return {
			value: {
				kind: "callable",
				name,
				targetType: context.targetType,
				site: context.site,
				signature,
				nullable: true,
				...(callable.lifetime === "owner" ? { owner: context.owner! } : {}),
			},
		};
	}

	function(
		declaration: CFunction,
		facts: FunctionFacts,
		closes: number | undefined,
		callableContext?: {
			readonly targetType?: string;
			readonly path: string;
			readonly site: string;
			readonly owner?: string;
			readonly fixedArrayParameters?: true;
			readonly boundedGlobal?: GlobalAccessor["bounded"];
		},
	): BoundFunction | UnboundFunction {
		const where = (at: string): string =>
			`${callableContext?.path ?? `functions.${declaration.name}`}.${at}`;
		const gaps: Array<Gap> = [];
		if (declaration.variadic) {
			gaps.push({ at: "arguments", reason: "variadic arguments need a fact per call" });
		}
		const names = declaration.params.map(
			(param, index) => param.name ?? `arg${index + 1}`,
		);
		const factsAt = (index: number): MaligatorFfiValueFacts =>
			facts.params[index] ?? NO_FACTS;
		const parameterIndex = (reference: string, at: string): number => {
			const index = /^\d+$/.test(reference)
				? Number(reference) - 1
				: declaration.params.findIndex((param) => param.name === reference);
			if (index < 0 || index >= declaration.params.length) {
				throw new FfiError(
					`${where(at)}: ${declaration.name} has no parameter '${reference}'`,
				);
			}
			return index;
		};
		const map = (
			type: CType,
			position: Position,
			valueFacts: MaligatorFfiValueFacts,
			at: string,
		): Mapping => {
			const resolved = resolveCType(this.#model, type);
			if (resolved.kind === "array" && callableContext?.boundedGlobal !== undefined)
				return { value: { kind: callableContext.boundedGlobal.format, nullable: false } };
			if (valueFacts.callable !== undefined) {
				if (position !== "return")
					throw new FfiError(
						`${where(at)}.callable: callable applies to returned function pointers`,
					);
				const source =
					callableContext?.targetType === undefined
						? declaration.name
						: `((${callableContext.targetType}) nullptr)`;
				const arguments_ = declaration.params.map(({ type }) => {
					const resolved = resolveCType(this.#model, type);
					if (resolved.kind !== "record") return "0";
					const spelling =
						type.kind === "typedef"
							? formatCDeclaration(type)
							: (this.#accesses.get(resolved.name)?.spelling ?? formatCDeclaration(type));
					return `(${spelling}){0}`;
				});
				const targetType = `__typeof__(${source}(${arguments_.join(", ")}))`;
				return this.#callable(type, valueFacts, {
					targetType,
					path: where(at),
					site: `${callableContext?.site ?? declaration.name} result`,
					location: declaration.location,
					...(callableContext?.owner === undefined
						? {}
						: { owner: callableContext.owner }),
				});
			}
			for (const fact of ["string", "bytes", "array"] as const) {
				if (
					valueFacts[fact] !== undefined &&
					resolved.kind !== "pointer" &&
					resolved.kind !== "array"
				) {
					throw new FfiError(
						`${where(at)}: ${fact} applies to pointers, not ${formatCDeclaration(type)}`,
					);
				}
			}
			try {
				return this.value(type, position, valueFacts);
			} catch (error) {
				if (error instanceof FfiError)
					throw new FfiError(`${where(at)}: ${error.message}`);
				throw error;
			}
		};

		// The parameters that carry a buffer's or array's count, mapped to that argument.
		const counts = new Map<number, number>();
		declaration.params.forEach((_, index) => {
			const valueFacts = factsAt(index);
			const counted = valueCount(valueFacts);
			if (counted === undefined) return;
			const at = `params.${names[index]}.${counted.kind}.length`;
			const count = parameterIndex(counted.count.length, at);
			if (
				valueFacts.out === true &&
				resolveCType(this.#model, declaration.params[count]!.type).kind !== "pointer"
			)
				throw new FfiError(
					`${where(at)}: an out value needs a count C writes through a pointer`,
				);
			if (count === index || counts.has(count)) {
				throw new FfiError(
					`${where(at)}: '${counted.count.length}' already counts another argument`,
				);
			}
			counts.set(count, index);
		});
		// The user-data parameters that route callbacks, mapped to their callback argument.
		const callbackData = new Map<number, number>();
		declaration.params.forEach((_, index) => {
			const callback = factsAt(index).callback;
			if (callback?.data === undefined) return;
			const at = `params.${names[index]}.callback.data`;
			const data = parameterIndex(callback.data, at);
			const resolved = resolveCType(this.#model, declaration.params[data]!.type);
			if (
				resolved.kind !== "pointer" ||
				resolveCType(this.#model, resolved.to).kind !== "void" ||
				callbackData.has(data) ||
				counts.has(data)
			) {
				throw new FfiError(
					`${where(at)}: '${callback.data}' is not a free void * parameter`,
				);
			}
			callbackData.set(data, index);
		});
		// The destructor parameters of kept callbacks, mapped to their callback argument.
		const callbackReleases = new Map<number, number>();
		declaration.params.forEach((_, index) => {
			const release = factsAt(index).callback?.release;
			if (release === undefined) return;
			const at = `params.${names[index]}.callback.release`;
			const position = parameterIndex(release, at);
			const resolved = resolveCType(this.#model, declaration.params[position]!.type);
			const target =
				resolved.kind === "pointer" ? resolveCType(this.#model, resolved.to) : undefined;
			const first = target?.kind === "function" ? target.params[0] : undefined;
			const takes = first === undefined ? undefined : resolveCType(this.#model, first);
			if (
				target?.kind !== "function" ||
				target.variadic ||
				target.params.length !== 1 ||
				takes === undefined ||
				resolveCType(this.#model, target.returns).kind !== "void" ||
				takes.kind !== "pointer" ||
				resolveCType(this.#model, takes.to).kind !== "void" ||
				callbackData.has(position) ||
				callbackReleases.has(position) ||
				counts.has(position) ||
				factsAt(position).callback !== undefined
			) {
				throw new FfiError(
					`${where(at)}: '${release}' is not a free void (*)(void *) parameter`,
				);
			}
			callbackReleases.set(position, index);
		});
		const resultCounted = valueCount(facts.returns);
		const resultCount =
			resultCounted === undefined
				? undefined
				: parameterIndex(
						resultCounted.count.length,
						`returns.${resultCounted.kind}.length`,
					);

		const params: Array<MappedParameter> = [];
		const args: Array<Argument> = [];
		const outputs: Array<MappedOutput> = [];
		declaration.params.forEach((param, index) => {
			const name = names[index]!;
			const valueFacts = factsAt(index);
			const at = `params.${name}`;
			const gap = (reason: string): void => {
				gaps.push({ at: `param ${index + 1} (${name})`, reason });
			};
			if (valueFacts.borrowed === true) {
				throw new FfiError(`${where(at)}: borrowed applies to results`);
			}
			const resolved = resolveCType(this.#model, param.type);
			const routed = callbackData.get(index);
			const released = callbackReleases.get(index);
			if (released !== undefined) {
				args.push({ kind: "callback-release", of: released });
				return;
			}
			if (valueFacts.constant !== undefined || valueFacts.sizeof !== undefined) {
				if (
					Object.keys(valueFacts).length > 1 ||
					routed !== undefined ||
					counts.has(index) ||
					resultCount === index
				) {
					throw new FfiError(`${where(at)}: a constant parameter takes no other role`);
				}
				if (valueFacts.sizeof !== undefined) {
					const record = factRecord(this.#model, valueFacts.sizeof);
					const mapped =
						resolved.kind === "integer" ? this.#integer(resolved.name) : undefined;
					if (record?.complete !== true)
						throw new FfiError(
							`${where(at)}.sizeof: '${valueFacts.sizeof}' needs a complete record type`,
						);
					if (
						mapped === undefined ||
						!("value" in mapped) ||
						(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
					)
						throw new FfiError(
							`${where(at)}.sizeof: sizeof requires an integer parameter`,
						);
					args.push({
						kind: "constant",
						expression: `sizeof(${recordSpelling(this.#model, record)})`,
						sizeLimit: (
							(1n << BigInt(mapped.value.bits - (mapped.value.signed ? 1 : 0))) -
							1n
						).toString(),
					});
				} else args.push({ kind: "constant", expression: valueFacts.constant! });
				return;
			}
			if (routed !== undefined) {
				args.push({ kind: "callback-data", of: routed });
				return;
			}
			if (valueFacts.callback !== undefined) {
				const mapped = this.#callback(
					resolved,
					valueFacts.nullable === true,
					valueFacts.callback,
					where(at),
				);
				if ("gap" in mapped) gap(mapped.gap);
				else {
					params.push({ name, type: param.type, value: mapped.value });
					args.push({ kind: "input", param: params.length - 1 });
				}
				return;
			}
			const counted = counts.get(index);
			if (counted !== undefined || resultCount === index) {
				const pointer = resolved.kind === "pointer";
				const countType = pointer ? resolveCType(this.#model, resolved.to) : resolved;
				if (countType.kind === "integer" && "gap" in this.#integer(countType.name))
					throw new FfiError(
						`${where(at)}: a count needs a supported integer of at most 64 bits`,
					);
				if (
					countType.kind !== "integer" ||
					(pointer &&
						counted !== undefined &&
						(resultCount === index ||
							(factsAt(counted).bytes === undefined &&
								!(
									typeof factsAt(counted).string === "object" &&
									(factsAt(counted).out === true || factsAt(counted).inout === true)
								))))
				) {
					throw new FfiError(`${where(at)}: a count must be an integer parameter`);
				}
				if (counted !== undefined && pointer) {
					const written = map(resolved.to, "return", NO_FACTS, at);
					if ("gap" in written) {
						gap(written.gap);
						return;
					}
					args.push({ kind: "count", of: counted, output: outputs.length });
					outputs.push({ name, type: resolved.to, value: written.value });
					return;
				}
				if (counted !== undefined) {
					args.push({ kind: "count", of: counted });
					return;
				}
				if (pointer) {
					args.push({ kind: "result-count" });
					return;
				}
				// An integer input that also sizes the result stays a parameter.
			}
			if (valueFacts.out === true || valueFacts.inout === true) {
				const fact = valueFacts.out === true ? "out" : "inout";
				if (valueFacts.out === true && valueFacts.inout === true) {
					throw new FfiError(`${where(at)}: a parameter is out or inout, not both`);
				}
				if (resolved.kind !== "pointer") {
					throw new FfiError(`${where(at)}.${fact}: ${name} is not a pointer`);
				}
				let target = resolveCType(this.#model, resolved.to);
				while (target.kind === "array") target = resolveCType(this.#model, target.of);
				const record =
					target.kind === "record" ? this.#model.records.get(target.name) : undefined;
				if (record !== undefined && cRecordHasConstMembers(this.#model, record)) {
					gap(
						`${record.name}: const members require initialization rather than an output buffer`,
					);
					return;
				}
				const written = map(
					resolved.to,
					"return",
					{ ...valueFacts, nullable: undefined },
					at,
				);
				if ("gap" in written) {
					gap(written.gap);
					return;
				}
				this.#free(valueFacts.free, written.value, where(at));
				const output = outputs.length;
				const countedOutput = valueCount(valueFacts);
				outputs.push({
					name,
					type: resolved.to,
					value: written.value,
					...(countedOutput === undefined
						? {}
						: {
								count: parameterIndex(
									countedOutput.count.length,
									`${at}.${countedOutput.kind}.length`,
								),
							}),
				});
				if (valueFacts.inout !== true) {
					args.push({ kind: "out", output });
					return;
				}
				const read = map(
					resolved.to,
					"param",
					valueFacts.string === undefined
						? { ...(valueFacts.shape === undefined ? {} : { shape: valueFacts.shape }) }
						: {
								string: valueFacts.string,
								nullable: valueFacts.nullable,
							},
					at,
				);
				if ("gap" in read) {
					gap(read.gap);
					return;
				}
				params.push({ name, type: resolved.to, value: read.value });
				args.push({ kind: "inout", param: params.length - 1, output });
				return;
			}
			if (valueFacts.free !== undefined) {
				throw new FfiError(
					`${where(at)}.free: free applies to results and out parameters`,
				);
			}
			const mapped = map(
				param.type,
				callableContext?.fixedArrayParameters === true && resolved.kind === "array"
					? "field"
					: "param",
				valueFacts,
				at,
			);
			if ("gap" in mapped) {
				gap(mapped.gap);
				return;
			}
			if (
				valueFacts.nullable === true &&
				!("nullable" in mapped.value && mapped.value.nullable)
			) {
				throw new FfiError(
					`${where(at)}: nullable applies to string, handle, buffer, and array pointers`,
				);
			}
			params.push({ name, type: param.type, value: mapped.value });
			args.push({ kind: "input", param: params.length - 1 });
		});

		const replaced =
			gaps.length === 0
				? this.#replaced(declaration, factsAt, args, params, where)
				: undefined;
		if (gaps.length === 0)
			this.#closingCallback(declaration, factsAt, args, params, where);
		if (facts.returns.constant !== undefined) {
			throw new FfiError(`${where("returns.constant")}: constant applies to parameters`);
		}
		if (facts.returns.sizeof !== undefined)
			throw new FfiError(`${where("returns.sizeof")}: sizeof applies to parameters`);
		const returns: Mapping =
			replaced !== undefined &&
			Object.keys(facts.returns).length === 0 &&
			this.#returnsPrevious(
				declaration,
				replaced,
				factsAt(replaced).callback?.data !== undefined,
			)
				? { value: { kind: "undefined" } }
				: map(declaration.returns, "return", facts.returns, "returns");
		if ("value" in returns) {
			if (facts.returns.borrowed === true && returns.value.kind !== "handle") {
				throw new FfiError(`${where("returns.borrowed")}: the result is not a handle`);
			}
			const counted =
				returns.value.kind === "bytes" ||
				returns.value.kind === "sequence" ||
				(returns.value.kind === "string" && returns.value.counted === true);
			if (
				callableContext?.boundedGlobal === undefined &&
				counted !== (resultCount !== undefined)
			) {
				throw new FfiError(
					`${where("returns")}: a buffer or array result needs its length`,
				);
			}
			this.#free(facts.returns.free, returns.value, where("returns"));
			if (
				outputs.some((output) => output.name === "result") &&
				returns.value.kind !== "undefined"
			) {
				throw new FfiError(
					`${where("params.result")}: an output named 'result' hides the result`,
				);
			}
		} else gaps.push({ at: "return", reason: returns.gap });
		if ("gap" in returns || gaps.length > 0) {
			return { name: declaration.name, declaration, gaps };
		}
		if (
			closes !== undefined &&
			(args[0]?.kind !== "input" ||
				args[0].param !== closes ||
				params[closes]?.value.kind !== "handle")
		)
			throw new FfiError(
				`${where("params")}: a destroy function must keep its handle as an input`,
			);
		return {
			name: declaration.name,
			declaration,
			params,
			arguments: args,
			returns: returns.value,
			...(resultCount === undefined ? {} : { resultCount }),
			outputs,
			...(closes === undefined ? {} : { closes }),
		};
	}
}

function constantValue(value: bigint, mapping: JsValue): bigint | number {
	return mapping.kind === "bigint" ? value : Number(value);
}

/**
 * Bind one variant of a variadic function as a declaration whose variadic arguments
 * have the variant's types, exported under the variant's name. Calls still go to the
 * variadic function, so the C compiler applies the default argument promotions.
 */
function planVariant(
	model: CModel,
	planner: Planner,
	declaration: CFunction,
	stated: FunctionFacts | undefined,
	name: string,
	variant: MaligatorFfiVariant,
): BoundFunction | UnboundFunction {
	const at = `functions.${declaration.name}.variants.${name}`;
	if (!declaration.variadic) {
		throw new FfiError(`${at}: ${declaration.name} is not variadic`);
	}
	const fixed = declaration.params.length;
	const params = [
		...declaration.params,
		...variant.args.map((spelling, index) => {
			const type = parseCType(spelling);
			if (
				type.kind === "unsupported" ||
				resolveCType(model, type).kind === "unsupported"
			) {
				throw new FfiError(`${at}.args[${index}]: '${spelling}' is not a C type`);
			}
			return { name: `arg${fixed + index + 1}`, type };
		}),
	];
	const paramFacts: Array<MaligatorFfiValueFacts | undefined> = params.map(
		(_, index) => stated?.params[index],
	);
	for (const [key, valueFacts] of Object.entries(variant.params ?? {})) {
		const index = /^\d+$/.test(key)
			? Number(key) - 1
			: params.findIndex((param) => param.name === key);
		if (index < fixed || index >= params.length) {
			throw new FfiError(`${at}.params.${key}: ${name} has no such variadic argument`);
		}
		paramFacts[index] = valueFacts;
	}
	const result = planner.function(
		{ ...declaration, params, variadic: false },
		{ params: paramFacts, returns: stated?.returns ?? NO_FACTS },
		undefined,
	);
	return { ...result, name };
}

export function planBindings(
	model: CModel,
	facts: LibraryFacts = EMPTY_FACTS,
): BindingPlan {
	const handleMap = handleTypes(model, facts);
	const factMap = functionFacts(model, facts);
	const closers = new Map<string, number>();
	for (const handle of handleMap.values()) {
		if (handle.destroy !== undefined) closers.set(handle.destroy.name, 0);
	}
	const planner = new Planner(model, handleMap, facts);
	const functions: Array<BoundFunction> = [];
	const unbound: Array<UnboundFunction> = [];
	const declared = new Set(model.functions.map((declaration) => declaration.name));
	for (const declaration of model.functions) {
		const variants = Object.entries(facts.functions[declaration.name]?.variants ?? {});
		if (variants.length > 0) {
			// A variadic function binds only through its variants.
			for (const [name, variant] of variants) {
				if (declared.has(name)) {
					throw new FfiError(
						`functions.${declaration.name}.variants.${name}: '${name}' is already a function`,
					);
				}
				declared.add(name);
				const result = planVariant(
					model,
					planner,
					declaration,
					factMap.get(declaration.name),
					name,
					variant,
				);
				if ("gaps" in result) unbound.push(result);
				else functions.push(result);
			}
			continue;
		}
		const result = planner.function(
			declaration,
			factMap.get(declaration.name) ?? { params: [], returns: NO_FACTS },
			closers.get(declaration.name),
		);
		const asyncName = facts.functions[declaration.name]?.async;
		if (asyncName !== undefined) {
			const at = `functions.${declaration.name}.async`;
			if (declared.has(asyncName)) {
				throw new FfiError(`${at}: '${asyncName}' is already a function`);
			}
			declared.add(asyncName);
		}
		if ("gaps" in result) unbound.push(result);
		else
			functions.push(asyncName === undefined ? result : { ...result, async: asyncName });
	}
	const handles = new Map<string, HandleType>();
	const fieldFacts = new Map<string, Readonly<Record<string, MaligatorFfiFieldFacts>>>();
	for (const [name, type] of Object.entries(facts.types)) {
		const record = type.handle === undefined ? undefined : factRecord(model, name);
		if (record !== undefined && type.fields !== undefined)
			fieldFacts.set(record.name, type.fields);
	}
	for (const [name, handle] of handleMap) {
		const record = model.records.get(name);
		const fields = fieldFacts.get(name) ?? {};
		const managedFields =
			record === undefined ? [] : planner.managedFields(record, fields);
		handles.set(name, {
			...handle,
			fields:
				record !== undefined
					? planner.handleFields(
							record,
							managedFields,
							handle,
							fields,
							handle.representation === "struct" || handle.allocator !== undefined,
						)
					: [],
			managedFields,
		});
	}
	const families = new Map<string, Array<HandleType>>();
	for (const handle of handles.values()) {
		const family = families.get(handle.family) ?? [];
		family.push(handle);
		families.set(handle.family, family);
	}
	for (const family of families.values()) {
		const callableNames = new Set(
			family.flatMap((handle) =>
				handle.fields
					.filter((field) => field.value.kind === "callable")
					.map((field) => field.name),
			),
		);
		const owners = new Map<string, string>();
		for (const handle of family)
			for (const field of [...handle.fields, ...handle.managedFields]) {
				if (!callableNames.has(field.name)) continue;
				const previous = owners.get(field.name);
				if (previous !== undefined)
					throw new FfiError(
						`types.${handle.name}.fields.${field.name}: callable view field conflicts with ${previous}`,
					);
				owners.set(field.name, `${handle.name}.${field.name}`);
			}
	}

	const constants: Array<MappedConstant> = [];
	const skippedConstants: Array<SkippedConstant> = [];
	const seen = new Set<string>();
	// An unnamed enum is also registered under its typedef name; visit that entry
	// first so its constants carry the name C code uses.
	const isIdentifier = (name: string): boolean => /^[A-Za-z_]\w*$/.test(name);
	const enums = [...model.enums.values()].sort(
		(left, right) => Number(isIdentifier(right.name)) - Number(isIdentifier(left.name)),
	);
	for (const declaration of enums) {
		if (!declaration.library) continue;
		const type: CType = declaration.named
			? { kind: "enum", name: declaration.name }
			: isIdentifier(declaration.name)
				? { kind: "typedef", name: declaration.name }
				: declaration.underlying;
		const underlying = resolveCType(model, declaration.underlying);
		const mapped = planner.value(underlying, "constant");
		for (const constant of declaration.constants) {
			if (seen.has(constant.name)) continue;
			seen.add(constant.name);
			if ("gap" in mapped) {
				skippedConstants.push({ name: constant.name, reason: mapped.gap });
				continue;
			}
			constants.push({
				name: constant.name,
				source: "enum",
				type,
				value: mapped.value,
				known: constantValue(constant.value, mapped.value),
				...(constant.doc === undefined ? {} : { doc: constant.doc }),
			});
		}
	}
	for (const macro of model.macros) {
		if (!macro.library) continue;
		if (seen.has(macro.name)) continue;
		seen.add(macro.name);
		if (macro.contextual === true) {
			skippedConstants.push({
				name: macro.name,
				reason: "depends on the macro expansion context",
			});
			continue;
		}
		const resolved = resolveCType(model, macro.type);
		const isString =
			resolved.kind === "array" &&
			resolveCType(model, resolved.of).kind === "integer" &&
			typeof macro.value === "string";
		const mapped: Mapping = isString
			? { value: { kind: "string", nullable: false } }
			: planner.value(macro.type, "constant");
		if ("gap" in mapped) {
			skippedConstants.push({ name: macro.name, reason: mapped.gap });
			continue;
		}
		const known =
			typeof macro.value === "bigint"
				? constantValue(macro.value, mapped.value)
				: macro.value;
		constants.push({
			name: macro.name,
			source: "macro",
			type: macro.type,
			value: mapped.value,
			...(known === undefined ? {} : { known }),
			...(macro.doc === undefined ? {} : { doc: macro.doc }),
		});
	}
	for (const macro of model.untypedMacros) {
		if (!macro.library || macro.parameters !== undefined) continue;
		if (seen.has(macro.name)) continue;
		skippedConstants.push({ name: macro.name, reason: "not a constant expression" });
	}
	constants.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	const occupied = new Set([
		...declared,
		...constants.map(({ name }) => name),
		...[...handles.values()].flatMap((handle) =>
			handle.allocator === undefined ? [] : [handle.allocator],
		),
	]);
	for (const [name, entry] of Object.entries(facts.globals ?? {})) {
		const global = model.globals.find((global) => global.name === name);
		const at = `globals.${name}`;
		if (global === undefined)
			throw new FfiError(`${at}: the headers declare no global '${name}'`);
		if (global.linkage !== "external")
			throw new FfiError(`${at}: access requires an externally linked C object`);
		if (entry.get === undefined && entry.set === undefined)
			throw new FfiError(`${at}: provide a getter or setter export`);
		const { bytes, ...value } = entry.value ?? {};
		const resolved = resolveCType(model, global.type);
		const format =
			bytes === true ? "bytes" : value.string === true ? "string" : undefined;
		let bounded: GlobalAccessor["bounded"];
		if (resolved.kind === "array" && format !== undefined) {
			const element = resolveCType(model, resolved.of);
			if (element.kind !== "integer" || model.target.sizes[element.name] !== 1)
				throw new FfiError(
					`${at}.value: bounded text and bytes require a one-dimensional byte array`,
				);
			if (
				value.borrowed !== undefined ||
				value.callable !== undefined ||
				value.shape !== undefined
			)
				throw new FfiError(
					`${at}.value: a bounded array uses only its string or bytes representation`,
				);
			bounded = { format };
		} else if (bytes === true)
			throw new FfiError(`${at}.value.bytes: bytes require a fixed byte array`);
		if (
			resolved.kind === "array" &&
			bounded === undefined &&
			Object.keys(value).length > 0
		)
			throw new FfiError(`${at}.value: fixed arrays use their declared element mapping`);
		for (const access of ["get", "set"] as const) {
			const exported = entry[access];
			if (exported === undefined) continue;
			if (occupied.has(exported))
				throw new FfiError(`${at}.${access}: '${exported}' is already an export`);
			occupied.add(exported);
			if (access === "set" && !globalAssignable(model, global.type, handles))
				throw new FfiError(
					`${at}.set: a setter requires an assignable value without retained pointers`,
				);
			const storageType = globalStorageType(model, global.type);
			if (resolved.kind === "array" && !globalAssignable(model, storageType, handles))
				throw new FfiError(
					`${at}: an array accessor requires positive signed 32-bit bounds and resource-free values`,
				);
			const declaration: CFunction = {
				name: `mal_ffi_global_${access}_${name}`,
				returns: access === "get" ? storageType : { kind: "void" },
				params: access === "get" ? [] : [{ name: "value", type: storageType }],
				variadic: false,
				inline: true,
				attributes: [],
				location: global.location,
				...(global.doc === undefined ? {} : { doc: global.doc }),
			};
			const result = planner.function(
				declaration,
				{
					params: access === "get" ? [] : [NO_FACTS],
					returns: access === "get" && bounded === undefined ? value : NO_FACTS,
				},
				undefined,
				{
					path: access === "get" ? at : `${at}.set`,
					site: exported,
					...(resolved.kind === "array" ? { fixedArrayParameters: true as const } : {}),
					...(bounded === undefined ? {} : { boundedGlobal: bounded }),
				},
			);
			if (
				!("gaps" in result) &&
				access === "get" &&
				result.returns.kind === "handle" &&
				value.borrowed !== true
			)
				throw new FfiError(`${at}.value: a global handle requires borrowed: true`);
			const binding = {
				...result,
				name: exported,
				global: {
					declaration: global,
					access,
					...(bounded === undefined ? {} : { bounded }),
				},
			};
			if ("gaps" in binding) unbound.push(binding);
			else functions.push(binding);
		}
	}
	for (const handle of handles.values()) {
		if (
			handle.allocator !== undefined &&
			(declared.has(handle.allocator) ||
				constants.some((entry) => entry.name === handle.allocator))
		)
			throw new FfiError(
				`types.${handle.allocator}.handle.storage: '${handle.allocator}' is already an export`,
			);
	}
	return {
		functions,
		hasCallbacks:
			planner.hasCallableCallbacks ||
			functions.some((binding) =>
				binding.params.some(({ value }) => value.kind === "callback"),
			),
		unbound,
		records: planner.records,
		unions: planner.unions,
		tagged: planner.tagged,
		handles,
		constants,
		skippedConstants,
	};
}

function globalStorageType(model: CModel, type: CType): CType {
	const resolved = resolveCType(model, type);
	if (resolved.kind === "array")
		return { ...resolved, of: globalStorageType(model, resolved.of) };
	return "const" in resolved && resolved.const === true
		? { ...resolved, const: undefined }
		: type;
}

function globalAssignable(
	model: CModel,
	type: CType,
	handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>,
	seen = new Set<string>(),
): boolean {
	const resolved = resolveCType(model, type);
	if ("const" in resolved && resolved.const === true) return false;
	switch (resolved.kind) {
		case "bool":
		case "integer":
		case "float":
		case "enum":
			return true;
		case "array":
			return (
				resolved.length !== undefined &&
				resolved.length > 0 &&
				resolved.length <= 0x7fffffff &&
				globalAssignable(model, resolved.of, handles, seen)
			);
		case "record": {
			if (seen.has(resolved.name) || handles.has(resolved.name)) return false;
			const record = model.records.get(resolved.name);
			if (record?.complete !== true) return false;
			const nested = new Set([...seen, resolved.name]);
			return record.fields.every((field) =>
				globalAssignable(model, field.type, handles, nested),
			);
		}
		default:
			return false;
	}
}
