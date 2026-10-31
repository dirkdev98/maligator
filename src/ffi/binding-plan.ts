import type { CFunction, CModel, CRecord } from "./c-model.ts";
import { resolveCType } from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { CType } from "./c-type.ts";

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
	| { readonly kind: "array"; readonly of: JsValue; readonly length: number };

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
}

export interface MappedRecord {
	/** The type name generated declarations use. */
	readonly name: string;
	/** How C code spells the type: a typedef name or `struct tag`. */
	readonly spelling: string;
	readonly record: CRecord;
	readonly fields: ReadonlyArray<MappedField>;
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
	readonly constants: ReadonlyArray<MappedConstant>;
	readonly skippedConstants: ReadonlyArray<SkippedConstant>;
}

type Position = "param" | "return" | "field" | "constant";

class Planner {
	readonly #model: CModel;
	readonly records = new Map<string, MappedRecord>();
	readonly #recordGaps = new Map<string, string>();
	readonly #pending = new Set<string>();

	constructor(model: CModel) {
		this.#model = model;
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

	value(type: CType, position: Position): Mapping {
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
				return this.#pointer(resolved, position);
			case "array":
				if (position === "param") {
					return this.#pointer({ kind: "pointer", to: resolved.of }, position);
				}
				return this.#array(resolved, position);
			case "record":
				return this.#record(resolved.name, resolved.tag);
			case "function":
				return { gap: "function types need a callback fact" };
			case "typedef":
			case "unsupported":
				return { gap: `unsupported type '${formatCDeclaration(type)}'` };
		}
	}

	#pointer(type: Extract<CType, { kind: "pointer" }>, position: Position): Mapping {
		const target = resolveCType(this.#model, type.to);
		const spelling = formatCDeclaration(type);
		if (target.kind === "integer" && target.name === "char" && target.const === true) {
			if (position === "param") return { value: { kind: "string", nullable: false } };
			if (position === "return") return { value: { kind: "string", nullable: true } };
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
				fields.push({ name: field.name, type: field.type, value: mapped.value });
			}
		} finally {
			this.#pending.delete(name);
		}
		const typedefName = [...this.#model.typedefs.values()].find((typedef) => {
			const target = typedef.type;
			return target.kind === "record" && target.name === name && target.const !== true;
		})?.name;
		this.records.set(name, {
			name,
			spelling: record.named ? `${record.tag} ${name}` : (typedefName ?? name),
			record,
			fields,
		});
		return { value: { kind: "record", name } };
	}

	function(declaration: CFunction): BoundFunction | UnboundFunction {
		const gaps: Array<Gap> = [];
		if (declaration.variadic) {
			gaps.push({ at: "arguments", reason: "variadic arguments need a fact per call" });
		}
		const params: Array<MappedParameter> = [];
		declaration.params.forEach((param, index) => {
			const name = param.name ?? `arg${index + 1}`;
			const mapped = this.value(param.type, "param");
			if ("gap" in mapped) {
				gaps.push({ at: `param ${index + 1} (${name})`, reason: mapped.gap });
			} else params.push({ name, type: param.type, value: mapped.value });
		});
		const returns = this.value(declaration.returns, "return");
		if ("gap" in returns) gaps.push({ at: "return", reason: returns.gap });
		if ("gap" in returns || gaps.length > 0) {
			return { name: declaration.name, declaration, gaps };
		}
		return { name: declaration.name, declaration, params, returns: returns.value };
	}
}

function constantValue(value: bigint, mapping: JsValue): bigint | number {
	return mapping.kind === "bigint" ? value : Number(value);
}

/** Apply the mapping rules to every declaration a library's headers provide. */
export function planBindings(model: CModel): BindingPlan {
	const planner = new Planner(model);
	const functions: Array<BoundFunction> = [];
	const unbound: Array<UnboundFunction> = [];
	for (const declaration of model.functions) {
		const result = planner.function(declaration);
		if ("gaps" in result) unbound.push(result);
		else functions.push(result);
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
	return { functions, unbound, records: planner.records, constants, skippedConstants };
}
