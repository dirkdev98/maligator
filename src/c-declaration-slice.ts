import { createHash } from "node:crypto";
import { GENERATED_PRELUDE_END } from "./compiler/target/generated-prelude.ts";

export { GENERATED_PRELUDE_END };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const TOKEN =
	/\s+|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*|[A-Za-z_$][\w$]*|\.?\d(?:[eEpP][+-]|[\w.])*|\.\.\.|<<=|>>=|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\S/gy;

const KEYWORDS = new Set(
	(
		"auto break case char const continue default do double else enum extern float for goto if inline int " +
		"long register restrict return short signed sizeof static struct switch typedef union unsigned void " +
		"volatile while bool true false nullptr alignas alignof constexpr static_assert thread_local typeof " +
		"typeof_unqual _Alignas _Alignof _Atomic _BitInt _Bool _Complex _Generic _Imaginary _Noreturn " +
		"_Static_assert _Thread_local __attribute__ __restrict __restrict__ __inline __inline__ __asm__ asm " +
		"__extension__ __typeof__ __volatile__ __const"
	).split(" "),
);

/** Specifier groups whose parenthesized operands never name the declared entity. */
const SPECIFIER_GROUPS = new Set([
	"__attribute__",
	"__declspec",
	"_Alignas",
	"alignas",
	"__typeof__",
	"typeof",
	"typeof_unqual",
	"_Atomic",
	"__asm__",
	"asm",
]);

/** Attributes that emit or bind a definition whether or not the unit references it. */
const EMITTING_ATTRIBUTES = new Set([
	"used",
	"__used__",
	"retain",
	"__retain__",
	"constructor",
	"__constructor__",
	"destructor",
	"__destructor__",
	"section",
	"__section__",
	"alias",
	"__alias__",
	"weak",
	"__weak__",
	"weakref",
	"__weakref__",
	"ifunc",
	"__ifunc__",
	"externally_visible",
	"__externally_visible__",
]);

interface PreludeItem {
	readonly text: string;
	readonly identifiers: ReadonlyArray<string>;
}

/** Top-level declarations of one expanded prelude, indexed by the names they define. */
export interface PreludeDeclarations {
	readonly items: ReadonlyArray<PreludeItem>;
	/** Items that can affect any unit's object and are therefore always keyed. */
	readonly always: ReadonlyArray<number>;
	readonly definitions: ReadonlyMap<string, ReadonlyArray<number>>;
}

function tokens(text: string): Array<string> {
	const result: Array<string> = [];
	TOKEN.lastIndex = 0;
	for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
		const token = match[0];
		if (!/^\s/.test(token)) result.push(token);
	}
	if (TOKEN.lastIndex !== 0 && TOKEN.lastIndex !== text.length)
		throw new Error("unterminated token in preprocessed C");
	return result;
}

function splitItems(source: ReadonlyArray<string>): Array<Array<string>> {
	const items: Array<Array<string>> = [];
	let current: Array<string> = [];
	let depth = 0;
	let functionBody = false;
	let previous: string | undefined;
	for (const token of source) {
		if (token.startsWith("#") && depth === 0 && current.length === 0) {
			items.push([token]);
			continue;
		}
		current.push(token);
		if (token === "(" || token === "[" || token === "{") {
			if (token === "{" && depth === 0) functionBody = previous === ")";
			depth++;
		} else if (token === ")" || token === "]" || token === "}") {
			depth--;
			if (depth < 0) throw new Error("unbalanced preprocessed C");
			if (token === "}" && depth === 0 && functionBody) {
				items.push(current);
				current = [];
				functionBody = false;
				previous = undefined;
				continue;
			}
		} else if (token === ";" && depth === 0) {
			items.push(current);
			current = [];
			functionBody = false;
			previous = undefined;
			continue;
		}
		previous = token;
	}
	if (depth !== 0) throw new Error("unbalanced preprocessed C");
	if (current.length > 0) items.push(current);
	return items;
}

/** Index of the group closing at or after `start`, which must open a group. */
function closingIndex(item: ReadonlyArray<string>, start: number): number {
	let depth = 0;
	for (let index = start; index < item.length; index++) {
		const token = item[index]!;
		if (token === "(" || token === "[" || token === "{") depth++;
		else if (token === ")" || token === "]" || token === "}") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return item.length - 1;
}

/**
 * Names an item defines, or `undefined` when the item must be keyed for every unit.
 * Anything this cannot classify falls on the `undefined` side.
 */
function definedNames(item: ReadonlyArray<string>): Set<string> | undefined {
	if (item[0]!.startsWith("#")) return undefined;
	const head = item[0]!;
	if (
		head === "_Static_assert" ||
		head === "static_assert" ||
		head === "asm" ||
		head === "__asm__"
	)
		return undefined;
	const names = new Set<string>();
	let storage: "static" | "extern" | "typedef" | undefined;
	let inline = false;
	let functionDefinition = false;
	let initializer = false;
	let declaresFunction = false;
	let declarator = false;
	let index = 0;
	while (index < item.length) {
		const token = item[index]!;
		if (SPECIFIER_GROUPS.has(token) && item[index + 1] === "(") {
			const end = closingIndex(item, index + 1);
			if (token === "__attribute__" || token === "__declspec")
				for (let inner = index + 2; inner < end; inner++)
					if (EMITTING_ATTRIBUTES.has(item[inner]!)) return undefined;
			index = end + 1;
			continue;
		}
		if (token === "static" || token === "extern" || token === "typedef") {
			if (storage !== undefined && storage !== token) return undefined;
			storage = token;
		} else if (token === "inline" || token === "__inline" || token === "__inline__") {
			inline = true;
		} else if (token === "struct" || token === "union" || token === "enum") {
			const tag = item[index + 1];
			if (tag !== undefined && IDENTIFIER.test(tag) && !KEYWORDS.has(tag)) names.add(tag);
		} else if (token === "=") {
			initializer = true;
		} else if (token === "{") {
			const end = closingIndex(item, index);
			if (item[index - 1] === ")") {
				functionDefinition = true;
				break;
			}
			if (item.slice(0, index).includes("enum") && !initializer)
				for (let inner = index + 1; inner < end; inner++) {
					const enumerator = item[inner]!;
					const next = item[inner + 1];
					if (
						IDENTIFIER.test(enumerator) &&
						!KEYWORDS.has(enumerator) &&
						(next === "=" || next === "," || next === "}") &&
						(item[inner - 1] === "{" || item[inner - 1] === ",")
					)
						names.add(enumerator);
				}
			index = end + 1;
			continue;
		} else if (token === "(") {
			const name = item[index - 1];
			const pointer = item[index + 1] === "*" ? item[index + 2] : undefined;
			if (pointer !== undefined && IDENTIFIER.test(pointer) && !KEYWORDS.has(pointer)) {
				names.add(pointer);
				declarator = true;
			} else if (name !== undefined && IDENTIFIER.test(name) && !KEYWORDS.has(name)) {
				names.add(name);
				declaresFunction = true;
				declarator = true;
			}
			index = closingIndex(item, index) + 1;
			continue;
		} else if (token === "[") {
			index = closingIndex(item, index) + 1;
			continue;
		} else if (
			IDENTIFIER.test(token) &&
			!KEYWORDS.has(token) &&
			(item[index + 1] === ";" ||
				item[index + 1] === "," ||
				item[index + 1] === "=" ||
				item[index + 1] === "[" ||
				item[index + 1] === undefined)
		) {
			names.add(token);
			declarator = true;
		}
		index++;
	}
	if (names.size === 0) return undefined;
	if (storage === "typedef") return functionDefinition || initializer ? undefined : names;
	if (storage === "static") return names;
	if (functionDefinition) return inline && storage === undefined ? names : undefined;
	if (storage === "extern") return initializer ? undefined : names;
	// A bare function prototype or a tag-only aggregate declaration emits nothing.
	if ((declaresFunction && !initializer) || !declarator) return names;
	return undefined;
}

/** Splits an expanded unit at its prelude end, or `undefined` when it has none. */
export function splitExpandedUnit(
	expanded: string,
): { prelude: string; body: string } | undefined {
	const start = expanded.indexOf(GENERATED_PRELUDE_END);
	if (start < 0 || expanded.indexOf(GENERATED_PRELUDE_END, start + 1) >= 0)
		return undefined;
	return {
		prelude: expanded.slice(0, start),
		body: expanded.slice(start + GENERATED_PRELUDE_END.length),
	};
}

export function indexPreludeDeclarations(expandedPrelude: string): PreludeDeclarations {
	const items = splitItems(tokens(expandedPrelude)).map((item) => ({
		text: item.join(" "),
		identifiers: item.filter((token) => IDENTIFIER.test(token) && !KEYWORDS.has(token)),
		names: definedNames(item),
	}));
	const always: Array<number> = [];
	const definitions = new Map<string, Array<number>>();
	for (const [index, item] of items.entries()) {
		if (item.names === undefined) {
			always.push(index);
			continue;
		}
		for (const name of item.names) {
			const defining = definitions.get(name);
			if (defining === undefined) definitions.set(name, [index]);
			else defining.push(index);
		}
	}
	return {
		items: items.map(({ text, identifiers }) => ({ text, identifiers })),
		always,
		definitions,
	};
}

/**
 * Digest of everything one unit's compilation can observe: its expanded body and the
 * prelude declarations reachable from it. A prelude edit the unit cannot reach keeps
 * the digest; any change to a reachable declaration, pragma, or emitted definition
 * changes it.
 */
export function slicedUnitDigest(
	prelude: PreludeDeclarations,
	expandedBody: string,
): string {
	const included = new Set(prelude.always);
	const seen = new Set<string>();
	const pending: Array<string> = [];
	const reach = (identifier: string) => {
		if (seen.has(identifier)) return;
		seen.add(identifier);
		pending.push(identifier);
	};
	for (const token of tokens(expandedBody))
		if (IDENTIFIER.test(token) && !KEYWORDS.has(token)) reach(token);
	for (const index of prelude.always)
		for (const identifier of prelude.items[index]!.identifiers) reach(identifier);
	while (pending.length > 0) {
		for (const index of prelude.definitions.get(pending.pop()!) ?? []) {
			if (included.has(index)) continue;
			included.add(index);
			for (const identifier of prelude.items[index]!.identifiers) reach(identifier);
		}
	}
	const digest = createHash("sha256");
	for (const index of [...included].sort((left, right) => left - right))
		digest.update(prelude.items[index]!.text).update("\n");
	return digest.update("\0").update(expandedBody).digest("hex");
}

/**
 * Cache digest of one expanded generated unit: its declaration slice when the unit
 * ends a recognizable prelude, otherwise the whole expansion. `preludes` memoizes the
 * prelude index across the units of one build, which share the same expansion.
 */
export function expandedGeneratedUnitDigest(
	expanded: string,
	preludes: Map<string, PreludeDeclarations>,
): string {
	const whole = () =>
		createHash("sha256").update("expanded\0").update(expanded).digest("hex");
	const split = splitExpandedUnit(expanded);
	if (split === undefined) return whole();
	try {
		const preludeKey = createHash("sha256").update(split.prelude).digest("hex");
		let prelude = preludes.get(preludeKey);
		if (prelude === undefined) {
			prelude = indexPreludeDeclarations(split.prelude);
			preludes.set(preludeKey, prelude);
		}
		return createHash("sha256")
			.update("sliced\0")
			.update(slicedUnitDigest(prelude, split.body))
			.digest("hex");
	} catch {
		// Syntax this tokenizer does not model keeps the exact, always-sound whole key.
		return whole();
	}
}

/** Debug line tables encode source positions that a `-P` expansion no longer carries. */
export function compileArgumentsEmitDebugInfo(
	argumentsList: ReadonlyArray<string>,
): boolean {
	return argumentsList.some((argument) => /^-g/.test(argument) && argument !== "-g0");
}
