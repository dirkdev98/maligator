import type { CType } from "./c-type.ts";

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
	readonly doc?: string;
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
	readonly doc?: string;
	readonly location: CLocation;
}

export interface CField {
	readonly name?: string;
	readonly type: CType;
	readonly bitWidth?: number;
	readonly doc?: string;
}

export interface CRecord {
	/** The tag name, or the typedef name of an unnamed record. */
	readonly name: string;
	readonly tag: "struct" | "union";
	/** False for an opaque (forward-declared) record. */
	readonly complete: boolean;
	readonly fields: ReadonlyArray<CField>;
	/** Whether code spells it `struct name` or only through a typedef. */
	readonly named: boolean;
	readonly doc?: string;
	readonly location: CLocation;
	readonly library: boolean;
}

export interface CEnumConstant {
	readonly name: string;
	readonly value: bigint;
	readonly doc?: string;
}

export interface CEnum {
	readonly name: string;
	readonly named: boolean;
	readonly underlying: CType;
	readonly constants: ReadonlyArray<CEnumConstant>;
	readonly doc?: string;
	readonly location: CLocation;
	readonly library: boolean;
}

export interface CTypedef {
	readonly name: string;
	readonly type: CType;
	readonly doc?: string;
	readonly location: CLocation;
	readonly library: boolean;
}

/** An object-like macro whose body is a C expression of a known type. */
export interface CMacro {
	readonly name: string;
	readonly body: string;
	readonly type: CType;
	/** Known when the expression is an integer constant or a plain literal. */
	readonly value?: bigint | number | string;
	readonly doc?: string;
	readonly location: CLocation;
}

/** An object-like macro the probe could not type, kept so inspect can explain it. */
export interface CUntypedMacro {
	readonly name: string;
	readonly body: string;
	readonly location: CLocation;
}

export interface CModel {
	readonly target: CTarget;
	readonly headers: ReadonlyArray<{ readonly spelling: string; readonly path: string }>;
	/** Files whose declarations belong to the library. */
	readonly files: ReadonlyArray<string>;
	/** Every file the headers read, for cache identity. */
	readonly dependencies: ReadonlyArray<string>;
	readonly functions: ReadonlyArray<CFunction>;
	/** Records from every file, since library types can embed system ones. */
	readonly records: ReadonlyMap<string, CRecord>;
	readonly enums: ReadonlyMap<string, CEnum>;
	readonly typedefs: ReadonlyMap<string, CTypedef>;
	readonly macros: ReadonlyArray<CMacro>;
	readonly untypedMacros: ReadonlyArray<CUntypedMacro>;
}

/** Follow typedefs to the underlying type, keeping qualifiers spelled on the alias use. */
export function resolveCType(model: CModel, type: CType): CType {
	let current = type;
	const seen = new Set<string>();
	while (current.kind === "typedef") {
		if (seen.has(current.name)) return { kind: "unsupported", spelling: current.name };
		seen.add(current.name);
		const typedef = model.typedefs.get(current.name);
		if (typedef === undefined) return { kind: "unsupported", spelling: current.name };
		const isConst = current.const === true;
		current = typedef.type;
		if (
			isConst &&
			current.kind !== "array" &&
			current.kind !== "function" &&
			current.kind !== "unsupported"
		)
			current = { ...current, const: true };
	}
	return current;
}
