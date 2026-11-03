import type { CType } from "./c-type.ts";
import type { FfiText } from "./text.ts";

export interface CLocation {
	readonly file: string;
	readonly line: number;
}

/** Sizes and signedness the target compiler reports, so mappings never assume a data model. */
export interface CTarget {
	/** Byte sizes keyed by type name (`int`, `long double`, `void *`, ...). */
	readonly sizes: Readonly<Record<string, number>>;
	readonly charSigned: boolean;
}

export interface CParameter {
	readonly name?: string;
	readonly type: CType;
	readonly doc?: FfiText;
}

export interface CFunction {
	readonly name: string;
	readonly returns: CType;
	readonly params: ReadonlyArray<CParameter>;
	readonly variadic: boolean;
	/** Defined in the header (`static inline`), so it has no library symbol. */
	readonly inline: boolean;
	/** Clang attribute kinds without the `Attr` suffix, such as `WarnUnusedResult`. */
	readonly attributes: ReadonlyArray<string>;
	readonly doc?: FfiText;
	readonly location: CLocation;
}

/** A file-scope object; external linkage does not guarantee shared-library visibility. */
export interface CGlobal {
	readonly name: string;
	readonly type: CType;
	readonly linkage: "external" | "internal";
	readonly threadLocal: boolean;
	readonly attributes: ReadonlyArray<string>;
	readonly doc?: FfiText;
	readonly location: CLocation;
}

export interface CField {
	readonly name?: string;
	readonly type: CType;
	readonly bitWidth?: number;
	/** Compatible C type for a bit-field or enum field. */
	readonly integerType?: Extract<CType, { kind: "integer" }>;
	readonly doc?: FfiText;
}

export interface CRecord {
	/** The tag name, or the typedef name of an unnamed record. */
	readonly name: string;
	readonly tag: "struct" | "union";
	/** False for an opaque (forward-declared) record. */
	readonly complete: boolean;
	readonly fields: ReadonlyArray<CField>;
	readonly layout?: CRecordLayout;
	readonly attributes?: ReadonlyArray<string>;
	/** Whether code spells it `struct name` or only through a typedef. */
	readonly named: boolean;
	readonly doc?: FfiText;
	readonly location: CLocation;
	readonly library: boolean;
}

/** Target layout in bits, including unnamed and zero-width bit-fields in declaration order. */
export interface CRecordLayout {
	readonly sizeBits: number;
	readonly alignmentBits: number;
	readonly fieldOffsetsBits: ReadonlyArray<number>;
}

export interface CEnumConstant {
	readonly name: string;
	readonly value: bigint;
	readonly doc?: FfiText;
}

export interface CEnum {
	readonly name: string;
	readonly named: boolean;
	readonly underlying: CType;
	readonly constants: ReadonlyArray<CEnumConstant>;
	readonly doc?: FfiText;
	readonly location: CLocation;
	readonly library: boolean;
}

export interface CTypedef {
	readonly name: string;
	readonly type: CType;
	readonly attributes?: ReadonlyArray<string>;
	/** Target alignment, including explicit alignment attributes. */
	readonly alignmentBits?: number;
	/** Native arithmetic storage can include padding beyond its logical width or lanes. */
	readonly sizeBits?: number;
	readonly doc?: FfiText;
	readonly location: CLocation;
	readonly library: boolean;
}

/** Macro definitions retained for exports, contract dependencies, or documentation evidence. */
export interface CMacroDefinition {
	readonly name: string;
	readonly body: string;
	readonly parameters?: ReadonlyArray<string>;
	readonly variadic?: boolean;
	readonly library: boolean;
	readonly expansion?: string;
	readonly contextual?: boolean;
	readonly doc?: FfiText;
	readonly location: CLocation;
}

/** An object-like macro whose body is a C expression of a known type. */
export interface CMacro extends CMacroDefinition {
	readonly type: CType;
	/** Known when the expression is an integer constant or a plain literal. */
	readonly value?: bigint | number | string;
}

export type CUntypedMacro = CMacroDefinition;

export interface CModel {
	readonly target: CTarget;
	readonly headers: ReadonlyArray<{ readonly spelling: string; readonly path: string }>;
	/** Files whose declarations belong to the library. */
	readonly files: ReadonlyArray<string>;
	/** Native inputs read during extraction or needed to build the library. */
	readonly dependencies: ReadonlyArray<string>;
	readonly functions: ReadonlyArray<CFunction>;
	readonly globals: ReadonlyArray<CGlobal>;
	/** Records from every file, since library types can embed system ones. */
	readonly records: ReadonlyMap<string, CRecord>;
	readonly enums: ReadonlyMap<string, CEnum>;
	readonly typedefs: ReadonlyMap<string, CTypedef>;
	readonly macros: ReadonlyArray<CMacro>;
	readonly untypedMacros: ReadonlyArray<CUntypedMacro>;
}

/** Follow typedefs to the underlying type, keeping qualifiers spelled on the alias use. */
export function resolveCType(model: Pick<CModel, "typedefs">, type: CType): CType {
	const qualify = (value: CType): CType => {
		if (value.kind === "array") return { ...value, of: qualify(value.of) };
		return value.kind === "function" || value.kind === "unsupported"
			? value
			: { ...value, const: true };
	};
	let current = type;
	const seen = new Set<string>();
	while (current.kind === "typedef") {
		if (seen.has(current.name)) return { kind: "unsupported", spelling: current.name };
		seen.add(current.name);
		const typedef = model.typedefs.get(current.name);
		if (typedef === undefined) return { kind: "unsupported", spelling: current.name };
		const isConst = current.const === true;
		current = typedef.type;
		if (isConst) current = qualify(current);
	}
	return current;
}

/** A C aggregate cannot be assigned when any embedded object is const-qualified. */
export function cRecordHasConstMembers(
	model: Pick<CModel, "records" | "typedefs">,
	record: CRecord,
	seen = new Set<string>(),
): boolean {
	if (seen.has(record.name)) return false;
	seen.add(record.name);
	return record.fields.some((field) => {
		let type = resolveCType(model, field.type);
		while (type.kind === "array") type = resolveCType(model, type.of);
		if ("const" in type && type.const === true) return true;
		const child = type.kind === "record" ? model.records.get(type.name) : undefined;
		return child !== undefined && cRecordHasConstMembers(model, child, seen);
	});
}

export interface CRecordAccess {
	readonly owner: string;
	readonly path: ReadonlyArray<string>;
	/** Unevaluated member access, including C's promoted anonymous members. */
	readonly expression: string;
	readonly spelling?: string;
}

/** Spell nested anonymous types through an accessible containing declaration. */
export function cRecordAccesses(
	model: Pick<CModel, "records" | "typedefs">,
): ReadonlyMap<string, CRecordAccess> {
	const accesses = new Map<string, CRecordAccess>();
	const visit = (record: CRecord, access: CRecordAccess): void => {
		const known = accesses.get(record.name);
		if (
			known !== undefined &&
			(known.spelling !== undefined || access.spelling === undefined)
		)
			return;
		accesses.set(record.name, access);
		for (const field of record.fields) {
			let type = resolveCType(model, field.type);
			let expression =
				field.name === undefined
					? access.expression
					: `(${access.expression}).${field.name}`;
			const path =
				field.name === undefined ? [...access.path] : [...access.path, field.name];
			while (type.kind === "array") {
				type = resolveCType(model, type.of);
				expression += "[0]";
				path.push("[]");
			}
			if (type.kind !== "record") continue;
			const child = model.records.get(type.name);
			if (child !== undefined)
				visit(child, {
					owner: access.owner,
					path,
					expression,
					...(field.name === undefined ? {} : { spelling: `__typeof__(${expression})` }),
				});
		}
	};
	for (const record of model.records.values()) {
		if (!/^[A-Za-z_]\w*$/.test(record.name)) continue;
		const alias = [...model.typedefs.values()].find(
			(entry) =>
				entry.type.kind === "record" &&
				entry.type.name === record.name &&
				entry.type.const !== true,
		);
		const spelling = record.named ? `${record.tag} ${record.name}` : alias?.name;
		if (spelling === undefined) continue;
		visit(record, {
			owner: record.name,
			path: [],
			expression: `(*(${spelling} *)0)`,
			spelling,
		});
	}
	return accesses;
}

/** Anonymous structs promote their fields; anonymous unions retain their choice boundary. */
export function* promotedCFields(
	model: Pick<CModel, "records" | "typedefs">,
	record: CRecord,
): Generator<CField> {
	for (const field of record.fields) {
		const type = resolveCType(model, field.type);
		const nested = type.kind === "record" ? model.records.get(type.name) : undefined;
		if (field.name === undefined && nested?.tag === "struct")
			yield* promotedCFields(model, nested);
		else yield field;
	}
}

export interface CFieldStep {
	readonly record: CRecord;
	readonly field: CField;
	readonly index: number;
}

/** Resolve C member names without losing anonymous union choice boundaries. */
export function resolveCFieldPath(
	model: Pick<CModel, "records" | "typedefs">,
	record: CRecord,
	path: ReadonlyArray<string>,
): ReadonlyArray<CFieldStep> | undefined {
	if (path.length === 0) return undefined;
	for (const [index, field] of record.fields.entries()) {
		const step = { record, field, index };
		const type = resolveCType(model, field.type);
		const nested = type.kind === "record" ? model.records.get(type.name) : undefined;
		if (field.name === path[0]) {
			if (path.length === 1) return [step];
			const rest = nested && resolveCFieldPath(model, nested, path.slice(1));
			if (rest !== undefined) return [step, ...rest];
		} else if (field.name === undefined && nested !== undefined) {
			const rest = resolveCFieldPath(model, nested, path);
			if (rest !== undefined) return [step, ...rest];
		}
	}
	return undefined;
}
