import type { MaligatorFfiValueFacts } from "../public-api.d.ts";
import type { CFunction, CModel, CRecord } from "./c-model.ts";
import { resolveCType } from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { CType } from "./c-type.ts";
import type { LibraryFacts } from "./contract.ts";
import { FfiError } from "./ffi-error.ts";

/**
 * How a C value crosses into JavaScript. Mappings follow fixed rules so the same
 * header and facts always produce the same module.
 */
export type JsValue =
	| { readonly kind: "undefined" }
	| { readonly kind: "boolean" }
	/** An exact integer of at most 32 bits; other numbers throw on input. */
	| { readonly kind: "integer"; readonly bits: number; readonly signed: boolean }
	| { readonly kind: "float"; readonly bits: number }
	/** A 64-bit integer, exact in both directions. */
	| { readonly kind: "bigint"; readonly bits: number; readonly signed: boolean }
	/** UTF-8, NUL-terminated. Inputs are borrowed for the call; results are copied. */
	| { readonly kind: "string"; readonly nullable: boolean }
	/** A struct passed by value as a plain object. */
	| { readonly kind: "record"; readonly name: string }
	| { readonly kind: "array"; readonly of: JsValue; readonly length: number }
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
	  };

type Mapping = { readonly value: JsValue } | { readonly gap: string };

export interface MappedParameter {
	readonly name: string;
	readonly type: CType;
	readonly value: JsValue;
}

export interface BoundFunction {
	readonly name: string;
	readonly declaration: CFunction;
	readonly params: ReadonlyArray<MappedParameter>;
	readonly returns: JsValue;
	/** The parameter whose handle this destroy function releases, closed after the call. */
	readonly closes?: number;
}

/** A missing fact: where in the declaration it is needed and why. */
export interface Gap {
	/** `return`, `param 2 (title)`, or `arguments` for variadics. */
	readonly at: string;
	readonly reason: string;
}

export interface UnboundFunction {
	readonly name: string;
	readonly declaration: CFunction;
	readonly gaps: ReadonlyArray<Gap>;
}

export interface MappedField {
	readonly name: string;
	readonly type: CType;
	readonly value: JsValue;
	readonly doc?: string;
}

export interface MappedRecord {
	/** The type name generated declarations use. */
	readonly name: string;
	/** How C code spells the type: a typedef name or `struct tag`. */
	readonly spelling: string;
	readonly record: CRecord;
	readonly fields: ReadonlyArray<MappedField>;
}

/** A type whose values are handles, as the contract's facts and the headers define it. */
export interface HandleType {
	/** The struct the handle wraps, which also names its JavaScript type. */
	readonly name: string;
	/** How C code spells the struct type. */
	readonly spelling: string;
	/** A copy of a struct the library passes by value, or a pointer it returns. */
	readonly representation: "struct" | "pointer";
	readonly destroy?: {
		readonly name: string;
		/** Whether the destroy function takes the struct by value or by address. */
		readonly takes: "value" | "pointer";
	};
	readonly collect: boolean;
	/** Read-only accessors for a struct handle's value fields. */
	readonly fields: ReadonlyArray<MappedField>;
	readonly doc?: string;
}

export interface MappedConstant {
	readonly name: string;
	readonly source: "enum" | "macro";
	readonly type: CType;
	readonly value: JsValue;
	/** Known at build time; otherwise the binding reads the C expression when it loads. */
	readonly known?: bigint | number | string;
	readonly doc?: string;
}

export interface SkippedConstant {
	readonly name: string;
	readonly reason: string;
}

export interface BindingPlan {
	readonly functions: ReadonlyArray<BoundFunction>;
	readonly unbound: ReadonlyArray<UnboundFunction>;
	readonly records: ReadonlyMap<string, MappedRecord>;
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
): Map<string, Omit<HandleType, "fields">> {
	const handles = new Map<string, Omit<HandleType, "fields">>();
	for (const [key, typeFacts] of Object.entries(facts.types)) {
		const record = factRecord(model, key);
		if (record === undefined) {
			throw new FfiError(`types.${key}: the headers declare no struct named '${key}'`);
		}
		const handle = typeFacts.handle;
		if (handle === undefined) continue;
		if (handles.has(record.name)) {
			throw new FfiError(`types.${key}: ${record.name} already has a handle fact`);
		}
		const isRecord = (type: CType): boolean => {
			const resolved = resolveCType(model, type);
			return resolved.kind === "record" && resolved.name === record.name;
		};
		let destroy: HandleType["destroy"];
		if (handle.destroy !== undefined) {
			const declaration = model.functions.find((entry) => entry.name === handle.destroy);
			if (declaration === undefined) {
				throw new FfiError(
					`types.${key}.handle.destroy: the headers declare no function '${handle.destroy}'`,
				);
			}
			const param = declaration.params[0];
			const resolved = param === undefined ? undefined : resolveCType(model, param.type);
			if (
				declaration.params.length === 1 &&
				param !== undefined &&
				isRecord(param.type)
			) {
				destroy = { name: declaration.name, takes: "value" };
			} else if (
				declaration.params.length === 1 &&
				resolved?.kind === "pointer" &&
				isRecord(resolved.to)
			) {
				destroy = { name: declaration.name, takes: "pointer" };
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
			representation: record.complete && passedByValue ? "struct" : "pointer",
			...(destroy === undefined ? {} : { destroy }),
			collect: handle.collect === true,
			...(record.doc === undefined ? {} : { doc: record.doc }),
		});
	}
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
	readonly records = new Map<string, MappedRecord>();
	readonly #handles: ReadonlyMap<string, Omit<HandleType, "fields">>;
	readonly #recordGaps = new Map<string, string>();
	readonly #pending = new Set<string>();

	constructor(model: CModel, handles: ReadonlyMap<string, Omit<HandleType, "fields">>) {
		this.#model = model;
		this.#handles = handles;
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
				if (handle === undefined) return this.#record(resolved.name, resolved.tag);
				if (handle.representation === "pointer") {
					return {
						gap: `${handle.name} handles are pointers, not structs passed by value`,
					};
				}
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
		if (target.kind === "integer" && target.name === "char" && target.const === true) {
			if (position === "param") {
				return { value: { kind: "string", nullable: facts.nullable === true } };
			}
			if (position === "return") return { value: { kind: "string", nullable: true } };
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
		if (position === "field") {
			return { gap: `pointer field (${spelling}) needs an ownership fact` };
		}
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

	#record(name: string, tag: "struct" | "union"): Mapping {
		const known = this.records.get(name);
		if (known !== undefined) return { value: { kind: "record", name } };
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
		if (this.#pending.has(name)) return gap("recursive struct");
		this.#pending.add(name);
		const fields: Array<MappedField> = [];
		try {
			for (const field of record.fields) {
				if (field.name === undefined) return gap("anonymous members need a fact");
				if (field.bitWidth !== undefined)
					return gap(`bit-field '${field.name}' needs a fact`);
				const mapped = this.value(field.type, "field");
				if ("gap" in mapped) return gap(`field '${field.name}': ${mapped.gap}`);
				if (mapped.value.kind === "handle") {
					return gap(
						`field '${field.name}' holds a ${mapped.value.name} handle, so ${name} needs a handle fact too`,
					);
				}
				fields.push({
					name: field.name,
					type: field.type,
					value: mapped.value,
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		} finally {
			this.#pending.delete(name);
		}
		this.records.set(name, {
			name,
			spelling: recordSpelling(this.#model, record),
			record,
			fields,
		});
		return { value: { kind: "record", name } };
	}

	/** The value fields a struct handle exposes; others stay hidden behind the handle. */
	handleFields(record: CRecord): Array<MappedField> {
		const fields: Array<MappedField> = [];
		for (const field of record.fields) {
			if (field.name === undefined || field.bitWidth !== undefined) continue;
			const mapped = this.value(field.type, "field");
			// Accessors return single values; array fields stay behind the handle.
			if ("value" in mapped && mapped.value.kind !== "array") {
				fields.push({
					name: field.name,
					type: field.type,
					value: mapped.value,
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		}
		return fields;
	}

	function(
		declaration: CFunction,
		facts: FunctionFacts,
		closes: number | undefined,
	): BoundFunction | UnboundFunction {
		const gaps: Array<Gap> = [];
		if (declaration.variadic) {
			gaps.push({ at: "arguments", reason: "variadic arguments need a fact per call" });
		}
		const params: Array<MappedParameter> = [];
		declaration.params.forEach((param, index) => {
			const name = param.name ?? `arg${index + 1}`;
			const paramFacts = facts.params[index] ?? NO_FACTS;
			const mapped = this.value(param.type, "param", paramFacts);
			if ("gap" in mapped) {
				gaps.push({ at: `param ${index + 1} (${name})`, reason: mapped.gap });
				return;
			}
			if (paramFacts.borrowed === true) {
				throw new FfiError(
					`functions.${declaration.name}.params.${name}: borrowed applies to results`,
				);
			}
			if (
				paramFacts.nullable === true &&
				!("nullable" in mapped.value && mapped.value.nullable)
			) {
				throw new FfiError(
					`functions.${declaration.name}.params.${name}: nullable applies to string and handle pointers`,
				);
			}
			params.push({ name, type: param.type, value: mapped.value });
		});
		const returns = this.value(declaration.returns, "return", facts.returns);
		if ("gap" in returns) gaps.push({ at: "return", reason: returns.gap });
		else if (facts.returns.borrowed === true && returns.value.kind !== "handle") {
			throw new FfiError(
				`functions.${declaration.name}.returns.borrowed: the result is not a handle`,
			);
		}
		if ("gap" in returns || gaps.length > 0) {
			return { name: declaration.name, declaration, gaps };
		}
		return {
			name: declaration.name,
			declaration,
			params,
			returns: returns.value,
			...(closes === undefined ? {} : { closes }),
		};
	}
}

function constantValue(value: bigint, mapping: JsValue): bigint | number {
	return mapping.kind === "bigint" ? value : Number(value);
}

/**
 * Apply the mapping rules and the contract's facts to every declaration a
 * library's headers provide. Facts that name nothing in the headers throw.
 */
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
	const planner = new Planner(model, handleMap);
	const functions: Array<BoundFunction> = [];
	const unbound: Array<UnboundFunction> = [];
	for (const declaration of model.functions) {
		const result = planner.function(
			declaration,
			factMap.get(declaration.name) ?? { params: [], returns: NO_FACTS },
			closers.get(declaration.name),
		);
		if ("gaps" in result) unbound.push(result);
		else functions.push(result);
	}
	const handles = new Map<string, HandleType>();
	for (const [name, handle] of handleMap) {
		const record = model.records.get(name);
		handles.set(name, {
			...handle,
			fields:
				handle.representation === "struct" && record !== undefined
					? planner.handleFields(record)
					: [],
		});
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
		if (seen.has(macro.name)) continue;
		seen.add(macro.name);
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
		if (seen.has(macro.name)) continue;
		skippedConstants.push({ name: macro.name, reason: "not a constant expression" });
	}
	constants.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	return {
		functions,
		unbound,
		records: planner.records,
		handles,
		constants,
		skippedConstants,
	};
}
