/** Integer type names as clang spells them after typedef resolution. */
export const C_INTEGER_NAMES = [
	"char",
	"signed char",
	"unsigned char",
	"short",
	"unsigned short",
	"int",
	"unsigned int",
	"long",
	"unsigned long",
	"long long",
	"unsigned long long",
	"__int128",
	"unsigned __int128",
] as const;
export type CIntegerName = (typeof C_INTEGER_NAMES)[number];

export const C_FLOAT_NAMES = ["float", "double", "long double", "_Float16"] as const;
export type CFloatName = (typeof C_FLOAT_NAMES)[number];

/**
 * A C type as clang spells it. Typedef names stay symbolic so facts and generated
 * declarations keep the library's own vocabulary; `resolveCType` in the model
 * follows them when a mapping needs the underlying type.
 */
export type CType =
	| { readonly kind: "void"; readonly const?: true }
	| { readonly kind: "bool"; readonly const?: true }
	| { readonly kind: "integer"; readonly name: CIntegerName; readonly const?: true }
	| { readonly kind: "float"; readonly name: CFloatName; readonly const?: true }
	| {
			readonly kind: "pointer";
			readonly to: CType;
			readonly const?: true;
			readonly nullability?: "nonnull" | "nullable";
	  }
	| { readonly kind: "array"; readonly of: CType; readonly length?: number }
	| {
			readonly kind: "function";
			readonly returns: CType;
			readonly params: ReadonlyArray<CType>;
			readonly variadic: boolean;
	  }
	| {
			readonly kind: "record";
			readonly tag: "struct" | "union";
			readonly name: string;
			readonly const?: true;
	  }
	| { readonly kind: "enum"; readonly name: string; readonly const?: true }
	| { readonly kind: "typedef"; readonly name: string; readonly const?: true }
	| { readonly kind: "unsupported"; readonly spelling: string };

/**
 * The key clang's spelling gives an unnamed tag, such as
 * `struct (unnamed struct at /usr/include/x.h:3:9)`. The extractor keys unnamed
 * records and enums by the same location.
 */
export function unnamedTagKey(file: string, line: number, column: number): string {
	return `(unnamed at ${file}:${line}:${column})`;
}

const UNNAMED_TAG =
	/^\((?:unnamed|anonymous)(?: (?:struct|union|enum))? at (.+):(\d+):(\d+)\)/;

type Token =
	| { readonly kind: "word"; readonly text: string }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "punct"; readonly text: string }
	| { readonly kind: "unnamed"; readonly key: string };

function tokenize(spelling: string): Array<Token> | undefined {
	const tokens: Array<Token> = [];
	let index = 0;
	while (index < spelling.length) {
		const char = spelling[index]!;
		if (char === " " || char === "\t") {
			index++;
			continue;
		}
		if (spelling.startsWith("...", index)) {
			tokens.push({ kind: "punct", text: "..." });
			index += 3;
			continue;
		}
		if ("*()[],".includes(char)) {
			const previous = tokens.at(-1);
			if (
				char === "(" &&
				previous?.kind === "word" &&
				(previous.text === "struct" ||
					previous.text === "union" ||
					previous.text === "enum")
			) {
				const match = UNNAMED_TAG.exec(spelling.slice(index));
				if (match === null) return undefined;
				tokens.push({
					kind: "unnamed",
					key: unnamedTagKey(match[1]!, Number(match[2]), Number(match[3])),
				});
				index += match[0].length;
				continue;
			}
			tokens.push({ kind: "punct", text: char });
			index++;
			continue;
		}
		const word = /^[A-Za-z_]\w*/.exec(spelling.slice(index));
		if (word !== null) {
			tokens.push({ kind: "word", text: word[0] });
			index += word[0].length;
			continue;
		}
		const number = /^(?:0[xX][0-9a-fA-F]+|\d+)[uUlL]*/.exec(spelling.slice(index));
		if (number !== null) {
			tokens.push({
				kind: "number",
				value: Number(number[0].replace(/[uUlL]+$/, "")),
			});
			index += number[0].length;
			continue;
		}
		return undefined;
	}
	return tokens;
}

class Unsupported extends Error {}

const QUALIFIERS = new Set([
	"const",
	"volatile",
	"restrict",
	"__restrict",
	"__restrict__",
	"_Nonnull",
	"_Nullable",
	"_Null_unspecified",
	"_Nullable_result",
]);

/** Attributes that turn the spelled type into a different one, such as a SIMD vector. */
const REPRESENTATION_ATTRIBUTES = new Set([
	"vector_size",
	"ext_vector_type",
	"matrix_type",
	"address_space",
	"mode",
]);

const INTEGER_WORDS = new Set([
	"char",
	"short",
	"int",
	"long",
	"signed",
	"unsigned",
	"__int128",
]);

class Parser {
	readonly #tokens: ReadonlyArray<Token>;
	#index = 0;

	constructor(tokens: ReadonlyArray<Token>) {
		this.#tokens = tokens;
	}

	get done(): boolean {
		return this.#index === this.#tokens.length;
	}

	#peek(offset = 0): Token | undefined {
		return this.#tokens[this.#index + offset];
	}

	#isPunct(text: string, offset = 0): boolean {
		const token = this.#peek(offset);
		return token?.kind === "punct" && token.text === text;
	}

	#expectPunct(text: string): void {
		if (!this.#isPunct(text)) throw new Unsupported(`expected '${text}'`);
		this.#index++;
	}

	/** Skip an attribute that leaves the type's value representation unchanged. */
	#skipAttribute(): boolean {
		const token = this.#peek();
		if (token?.kind !== "word" || token.text !== "__attribute__") return false;
		this.#index++;
		this.#expectPunct("(");
		let depth = 1;
		while (depth > 0) {
			const next = this.#peek();
			if (next === undefined) throw new Unsupported("unterminated attribute");
			if (next.kind === "punct" && next.text === "(") depth++;
			if (next.kind === "punct" && next.text === ")") depth--;
			if (
				next.kind === "word" &&
				REPRESENTATION_ATTRIBUTES.has(next.text.replace(/^__|__$/g, ""))
			) {
				throw new Unsupported(next.text);
			}
			this.#index++;
		}
		return true;
	}

	/** Qualifiers that follow `*`; returns whether `const` was present. */
	#pointerQualifiers(): {
		readonly const: boolean;
		readonly nullability?: "nonnull" | "nullable";
	} {
		let isConst = false;
		let nullability: "nonnull" | "nullable" | undefined;
		for (;;) {
			if (this.#skipAttribute()) continue;
			const token = this.#peek();
			if (token?.kind !== "word" || !QUALIFIERS.has(token.text)) break;
			if (token.text === "const") isConst = true;
			if (token.text === "_Nonnull") nullability = "nonnull";
			if (token.text === "_Nullable" || token.text === "_Nullable_result")
				nullability = "nullable";
			this.#index++;
		}
		return nullability === undefined
			? { const: isConst }
			: { const: isConst, nullability };
	}

	/** Declaration specifiers: one base type plus qualifiers, in any order. */
	specifiers(): CType {
		let isConst = false;
		const integerWords: Array<string> = [];
		let base: CType | undefined;
		for (;;) {
			if (this.#skipAttribute()) continue;
			const token = this.#peek();
			if (token?.kind !== "word") break;
			const word = token.text;
			if (QUALIFIERS.has(word)) {
				if (word === "const") isConst = true;
				this.#index++;
				continue;
			}
			if (INTEGER_WORDS.has(word)) {
				integerWords.push(word);
				this.#index++;
				continue;
			}
			if (base !== undefined || integerWords.length > 0) break;
			this.#index++;
			if (word === "void") base = { kind: "void" };
			else if (word === "_Bool" || word === "bool") base = { kind: "bool" };
			else if (word === "float" || word === "double" || word === "_Float16")
				base = { kind: "float", name: word };
			else if (word === "struct" || word === "union" || word === "enum") {
				const name = this.#peek();
				this.#index++;
				const key =
					name?.kind === "word"
						? name.text
						: name?.kind === "unnamed"
							? name.key
							: undefined;
				if (key === undefined) throw new Unsupported(`${word} without a name`);
				base =
					word === "enum"
						? { kind: "enum", name: key }
						: { kind: "record", tag: word, name: key };
			} else if (
				word === "_Atomic" ||
				word === "typeof" ||
				word === "__typeof__" ||
				word === "_BitInt" ||
				word === "_Complex" ||
				word === "__fp16" ||
				word === "__bf16"
			) {
				throw new Unsupported(word);
			} else base = { kind: "typedef", name: word };
		}
		if (integerWords.length > 0) {
			if (base !== undefined) {
				// `long double` is the only floating type spelled with an integer word.
				if (
					base.kind === "float" &&
					base.name === "double" &&
					integerWords.length === 1 &&
					integerWords[0] === "long"
				)
					base = { kind: "float", name: "long double" };
				else throw new Unsupported("conflicting type specifiers");
			} else base = { kind: "integer", name: integerName(integerWords) };
		}
		if (base === undefined) throw new Unsupported("missing type specifier");
		return isConst ? withConst(base) : base;
	}

	/**
	 * An abstract declarator around `base`. Pointers bind to the base before the
	 * suffixes, and a parenthesized inner declarator applies last, which is how
	 * `void (*)(void *)` becomes a pointer to a function.
	 */
	declarator(base: CType): CType {
		let type = base;
		while (this.#isPunct("*")) {
			this.#index++;
			const qualifiers = this.#pointerQualifiers();
			type = {
				kind: "pointer",
				to: type,
				...(qualifiers.const ? { const: true as const } : {}),
				...(qualifiers.nullability === undefined
					? {}
					: { nullability: qualifiers.nullability }),
			};
		}
		let inner: Array<Token> | undefined;
		if (this.#isPunct("(") && (this.#isPunct("*", 1) || this.#isPunct("(", 1))) {
			const start = ++this.#index;
			let depth = 1;
			while (depth > 0) {
				const token = this.#peek();
				if (token === undefined) throw new Unsupported("unbalanced declarator");
				if (token.kind === "punct" && token.text === "(") depth++;
				if (token.kind === "punct" && token.text === ")") depth--;
				this.#index++;
			}
			inner = this.#tokens.slice(start, this.#index - 1);
		}
		const suffixes: Array<(type: CType) => CType> = [];
		for (;;) {
			if (this.#isPunct("[")) {
				this.#index++;
				const size = this.#peek();
				let length: number | undefined;
				if (size?.kind === "number") {
					length = size.value;
					this.#index++;
				}
				this.#expectPunct("]");
				suffixes.push((of) =>
					length === undefined ? { kind: "array", of } : { kind: "array", of, length },
				);
				continue;
			}
			if (this.#isPunct("(")) {
				this.#index++;
				const { params, variadic } = this.#parameters();
				suffixes.push((returns) => ({ kind: "function", returns, params, variadic }));
				continue;
			}
			break;
		}
		for (let index = suffixes.length - 1; index >= 0; index--)
			type = suffixes[index]!(type);
		if (inner !== undefined) {
			const nested = new Parser(inner);
			type = nested.declarator(type);
			if (!nested.done) throw new Unsupported("trailing declarator tokens");
		}
		while (this.#skipAttribute()) {
			// Function-type attributes such as noreturn do not change the mapping.
		}
		return type;
	}

	#parameters(): { params: ReadonlyArray<CType>; variadic: boolean } {
		const params: Array<CType> = [];
		let variadic = false;
		if (this.#isPunct(")")) {
			this.#index++;
			return { params, variadic };
		}
		for (;;) {
			if (this.#isPunct("...")) {
				this.#index++;
				variadic = true;
			} else params.push(this.typeName());
			if (this.#isPunct(",")) {
				this.#index++;
				continue;
			}
			this.#expectPunct(")");
			break;
		}
		if (params.length === 1 && params[0]!.kind === "void" && !variadic)
			return { params: [], variadic };
		return { params, variadic };
	}

	typeName(): CType {
		return this.declarator(this.specifiers());
	}
}

function integerName(words: ReadonlyArray<string>): CIntegerName {
	const unsigned = words.includes("unsigned");
	const signed = words.includes("signed");
	const longs = words.filter((word) => word === "long").length;
	let name: string;
	if (words.includes("__int128")) name = "__int128";
	else if (words.includes("char")) name = signed ? "signed char" : "char";
	else if (words.includes("short")) name = "short";
	else if (longs === 2) name = "long long";
	else if (longs === 1) name = "long";
	else name = "int";
	if (unsigned)
		return (
			name === "signed char" ? "unsigned char" : `unsigned ${name}`
		) as CIntegerName;
	return name as CIntegerName;
}

function withConst(type: CType): CType {
	switch (type.kind) {
		case "array":
		case "function":
		case "unsupported":
			return type;
		default:
			return { ...type, const: true };
	}
}

/** Parse a clang type spelling; unsupported constructs yield an `unsupported` type. */
export function parseCType(spelling: string): CType {
	const tokens = tokenize(spelling);
	if (tokens === undefined) return { kind: "unsupported", spelling };
	try {
		const parser = new Parser(tokens);
		const type = parser.typeName();
		return parser.done ? type : { kind: "unsupported", spelling };
	} catch (error) {
		if (error instanceof Unsupported) return { kind: "unsupported", spelling };
		throw error;
	}
}

function baseSpelling(type: CType): string {
	const prefix = "const" in type && type.const === true ? "const " : "";
	switch (type.kind) {
		case "void":
			return `${prefix}void`;
		case "bool":
			return `${prefix}bool`;
		case "integer":
		case "float":
			return `${prefix}${type.name}`;
		case "record":
			return `${prefix}${type.tag} ${type.name}`;
		case "enum":
			return `${prefix}enum ${type.name}`;
		case "typedef":
			return `${prefix}${type.name}`;
		case "unsupported":
			return type.spelling;
		default:
			throw new Error(`no base spelling for ${type.kind}`);
	}
}

/** Render `type` as a C declaration of `name`, or as an abstract type name. */
export function formatCDeclaration(type: CType, name = ""): string {
	let inner = name;
	let current = type;
	for (;;) {
		if (current.kind === "pointer") {
			const qualifier = current.const === true ? "const " : "";
			const pointer = `*${qualifier}${inner}`.trimEnd();
			inner =
				current.to.kind === "array" || current.to.kind === "function"
					? `(${pointer})`
					: pointer;
			current = current.to;
			continue;
		}
		if (current.kind === "array") {
			inner = `${inner}[${current.length ?? ""}]`;
			current = current.of;
			continue;
		}
		if (current.kind === "function") {
			const params =
				current.params.length === 0 && !current.variadic
					? "void"
					: [
							...current.params.map((param) => formatCDeclaration(param)),
							...(current.variadic ? ["..."] : []),
						].join(", ");
			inner = `${inner}(${params})`;
			current = current.returns;
			continue;
		}
		break;
	}
	const base = baseSpelling(current);
	if (inner === "") return base;
	return inner.startsWith("[") ? `${base}${inner}` : `${base} ${inner}`;
}
