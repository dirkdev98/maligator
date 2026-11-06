import type {
	MaligatorFfiFunctionFacts,
	MaligatorFfiTypeFacts,
	MaligatorFfiValueFacts,
} from "../public-api.d.ts";
import { planBindings } from "./binding-plan.ts";
import type { BindingPlan, BoundFunction, Gap, JsValue } from "./binding-plan.ts";
import { resolveCType } from "./c-model.ts";
import type { CFunction, CModel, CRecord } from "./c-model.ts";
import { formatCDeclaration } from "./c-type.ts";
import type { CType } from "./c-type.ts";
import type { LibraryFacts } from "./contract.ts";
import { FfiError, FfiFactError, factEntry } from "./ffi-error.ts";
import { textMatches } from "./text.ts";

/**
 * Facts that would make more declarations bind, shaped as a contract spells them so
 * they merge into one. They come from naming and signature conventions, not from
 * the library's documentation, so they are proposals to review.
 */
export interface SuggestedFacts {
	readonly types: Readonly<Record<string, MaligatorFfiTypeFacts>>;
	readonly functions: Readonly<Record<string, MaligatorFfiFunctionFacts>>;
	/** The functions that bind once every suggestion applies. */
	readonly binds: ReadonlyArray<string>;
}

const RELEASE_NAME = /unload|free|destroy|delete|release|close|dispose/i;
/** Words of a function or parameter that calls back only during the call. */
const SCOPED_WORDS = new Set([
	"sort",
	"each",
	"foreach",
	"visit",
	"visitor",
	"walk",
	"fold",
	"step",
	"map",
	"iterate",
	"iter",
	"traverse",
	"filter",
	"reduce",
	"compare",
	"comparator",
	"cmp",
	"search",
]);

/** Words of a setter's name; its next call replaces the callback it keeps. */
const SETTER_WORDS = new Set(["set", "on", "hook", "handler", "callback"]);
const COUNT_NAME = /(?:count|size|length|len|num)$/i;
/** A count of elements is no byte length, so buffers need a size-like name. */
const BYTE_COUNT_NAME = /(?:size|length|len|bytes)$/i;

function recordOf(model: CModel, type: CType): CRecord | undefined {
	const resolved = resolveCType(model, type);
	return resolved.kind === "record" ? model.records.get(resolved.name) : undefined;
}

function pointee(model: CModel, type: CType): CType | undefined {
	const resolved = resolveCType(model, type);
	return resolved.kind === "pointer" ? resolveCType(model, resolved.to) : undefined;
}

function isVoidPointer(model: CModel, type: CType): boolean {
	return pointee(model, type)?.kind === "void";
}

/** Bytes rather than elements: `void *` and the char types. */
function isByteType(type: CType): boolean {
	return type.kind === "void" || (type.kind === "integer" && type.name.endsWith("char"));
}

/** Character typedef names distinguish text from buffers with the same byte type. */
function isConstText(model: CModel, type: CType): boolean {
	const resolved = resolveCType(model, type);
	if (resolved.kind !== "pointer") return false;
	const target = resolveCType(model, resolved.to);
	if (target.kind !== "integer" || target.const !== true || !isByteType(target))
		return false;
	for (let current = resolved.to; current.kind === "typedef";) {
		if (/char\d*$/i.test(current.name)) return true;
		const typedef = model.typedefs.get(current.name);
		if (typedef === undefined) return false;
		current = typedef.type;
	}
	return false;
}

/** Verbs that release a resource, the most common choice first. */
const RELEASE_VERBS = [
	"destroy",
	"free",
	"delete",
	"release",
	"close",
	"dispose",
	"unload",
	"finalize",
	"finish",
	"cleanup",
];

function nameWords(name: string): Array<string> {
	return name
		.split(/_|(?<=[a-z\d])(?=[A-Z])/)
		.filter((word) => word !== "")
		.map((word) => word.toLowerCase());
}

function typeWords(name: string): Array<string> {
	return nameWords(name.replace(/^_+/, "").replace(/_(?:s|st|t|tag)$/, ""));
}

/**
 * Rank release names by verb, length, and whether their suffix names the struct.
 * `typeNames` starts with the struct tag, followed by aliases. The tag outranks an
 * alias because aliases may describe resources with different destructors.
 */
export function releaseRank(
	name: string,
	typeNames: ReadonlyArray<string>,
): number | undefined {
	const words = nameWords(name);
	const types = typeNames.map(typeWords);
	const own = types[0]?.join("");
	const endings = new Map<string, number>();
	for (const type of types) {
		const alias = type.join("") === own ? 0 : ALIAS_RELEASE;
		for (let index = 0; index < type.length; index++) {
			const ending = type.slice(index).join("");
			endings.set(ending, Math.min(endings.get(ending) ?? alias, alias));
		}
	}
	const prefixes = new Set(types.flatMap((type) => (type.length > 1 ? [type[0]!] : [])));
	for (let index = words.length - 1; index >= 0; index--) {
		const word = words[index]!;
		const verb = RELEASE_VERBS.findIndex(
			(candidate) =>
				word === candidate ||
				(word.endsWith(candidate) && prefixes.has(word.slice(0, -candidate.length))),
		);
		if (verb < 0) continue;
		const rest = words.slice(index + 1).join("");
		const ending = rest === "" ? 0 : endings.get(rest);
		return (ending ?? WEAK_RELEASE) + verb * 1000 + words.length * 10;
	}
	return undefined;
}

/** Ranks of names whose release verb an alias's name follows. */
const ALIAS_RELEASE = 10_000;
/** Ranks of names whose release verb other words follow. */
const WEAK_RELEASE = 100_000;

/**
 * A struct the library hands out and later releases: the function that takes only
 * the struct or its address and is best named as releasing it. An opaque struct
 * that no such function releases, or that reaches JavaScript only through callbacks,
 * is a handle without a destroy function: the library keeps owning it, or the program
 * releases it through a call of its own, such as libpng's `png_destroy_read_struct`.
 */
function suggestHandles(
	model: CModel,
	plan: BindingPlan,
): Map<string, MaligatorFfiTypeFacts> {
	// Index the model once by struct; ranking names per struct and function dominated
	// suggestions for headers with thousands of declarations.
	const typeNames = new Map<CRecord, Array<string>>();
	// Typedefs name the struct or its pointer, as zlib's `gzFile` does `gzFile_s`.
	for (const typedef of model.typedefs.values()) {
		const record = recordOf(model, pointee(model, typedef.type) ?? typedef.type);
		if (record !== undefined) appendTo(typeNames, record, typedef.name);
	}
	const singleArgument = new Map<CRecord, Array<CFunction>>();
	const handedOut = new Set<CRecord>();
	const pointedRecord = (type: CType): CRecord | undefined => {
		const target = pointee(model, type);
		return target?.kind === "record" ? model.records.get(target.name) : undefined;
	};
	for (const declaration of model.functions) {
		const returned = pointedRecord(declaration.returns);
		if (returned !== undefined) handedOut.add(returned);
		for (const param of declaration.params) {
			const target = pointee(model, param.type);
			const written = target === undefined ? undefined : pointedRecord(target);
			if (written !== undefined) handedOut.add(written);
		}
		const param = declaration.params[0];
		if (declaration.params.length !== 1 || param === undefined) continue;
		const record = recordOf(model, param.type) ?? pointedRecord(param.type);
		if (record !== undefined) appendTo(singleArgument, record, declaration);
	}
	const tagged = new Set([...plan.tagged.values()].map((entry) => entry.record.name));
	const handles = new Map<string, MaligatorFfiTypeFacts>();
	for (const record of model.records.values()) {
		if (
			!record.library ||
			record.tag !== "struct" ||
			plan.handles.has(record.name) ||
			plan.records.has(record.name) ||
			tagged.has(record.name)
		)
			continue;
		const names = [record.name, ...(typeNames.get(record) ?? [])];
		const releases = (singleArgument.get(record) ?? []).flatMap((declaration) => {
			const rank = releaseRank(declaration.name, names);
			return rank === undefined ? [] : [{ declaration, rank }];
		});
		const best = Math.min(...releases.map(({ rank }) => rank));
		const ranked = releases.filter(({ rank }) => rank === best);
		// Two equally good names leave the choice to the author, and so does a name for
		// one of several aliases, such as libxml2's `xmlFreeIDTable` for its shared hash
		// table, or a weak name with rivals.
		const sole = (limit: number): boolean =>
			releases.filter(({ rank }) => rank < limit).length === 1;
		const release =
			ranked.length === 1 &&
			(best < ALIAS_RELEASE ||
				(best < WEAK_RELEASE ? sole(WEAK_RELEASE) : sole(Number.POSITIVE_INFINITY)))
				? ranked[0]!.declaration
				: undefined;
		if (release !== undefined && resolveCType(model, release.returns).kind === "void") {
			handles.set(record.name, { handle: { destroy: release.name } });
		} else if (!record.complete && (releases.length === 0 || !handedOut.has(record))) {
			handles.set(record.name, { handle: {} });
		}
	}
	return handles;
}

function appendTo<K, V>(map: Map<K, Array<V>>, key: K, value: V): void {
	const values = map.get(key);
	if (values === undefined) map.set(key, [value]);
	else values.push(value);
}

/** The integer parameter that counts the elements or bytes behind pointer parameter `index`. */
function countParameter(
	model: CModel,
	declaration: CFunction,
	index: number,
	taken: ReadonlySet<number>,
	bytes: boolean,
): number | undefined {
	const countName = bytes ? BYTE_COUNT_NAME : COUNT_NAME;
	const name = (declaration.params[index]!.name ?? "").toLowerCase();
	const stem = name.replace(/s$/, "");
	const candidates = declaration.params.flatMap((param, position) => {
		if (position === index || taken.has(position)) return [];
		const resolved = resolveCType(model, param.type);
		// A buffer's size may go through a pointer the function updates, as in `compress`.
		const updated = bytes && pointee(model, param.type)?.kind === "integer";
		return resolved.kind === "integer" || updated
			? [{ position, name: (param.name ?? "").toLowerCase(), updated }]
			: [];
	});
	// A name built on the pointer's, such as `points` and `pointCount`, wins over position.
	const named = candidates.find(
		(candidate) =>
			stem !== "" && candidate.name.startsWith(stem) && countName.test(candidate.name),
	);
	if (named !== undefined) return named.position;
	const next = candidates.find(
		(candidate) => candidate.position === index + 1 && !candidate.updated,
	);
	// A bare `n` counts elements, or bytes behind a `void *`, which has no elements.
	const untyped = pointee(model, declaration.params[index]!.type)?.kind === "void";
	return next !== undefined &&
		(countName.test(next.name) || (next.name === "n" && (!bytes || untyped)))
		? next.position
		: undefined;
}

/**
 * The function that releases a pointer `declaration` returns: its `Load`/`Unload`
 * twin, or else the library's one release function that takes any pointer, when the
 * declaration's documentation says the caller frees the result. Libraries also
 * return static buffers through the same types, and freeing one corrupts memory.
 */
function releaseFunction(model: CModel, declaration: CFunction): string | undefined {
	const releases = model.functions.filter((candidate) => {
		const param = candidate.params[0];
		return (
			candidate.params.length === 1 &&
			param !== undefined &&
			pointee(model, param.type) !== undefined &&
			resolveCType(model, candidate.returns).kind === "void" &&
			RELEASE_NAME.test(candidate.name)
		);
	});
	const twin = declaration.name.replace(/^Load/, "Unload");
	if (
		twin !== declaration.name &&
		releases.some((candidate) => candidate.name === twin)
	) {
		return twin;
	}
	const generic = releases.filter((candidate) =>
		isVoidPointer(model, candidate.params[0]!.type),
	);
	if (generic.length !== 1) return undefined;
	const release = generic[0]!.name;
	const doc = declaration.doc;
	return doc?.includes(release) || textMatches(doc, /\bfree(?:s|d)?\b/i)
		? release
		: undefined;
}

/** A copied result: text, or bytes or elements counted through an out parameter. */
function suggestResult(
	model: CModel,
	declaration: CFunction,
): MaligatorFfiValueFacts | undefined {
	const target = pointee(model, declaration.returns);
	if (target === undefined || target.kind === "function") return undefined;
	// Constant text stays the library's, so the binding copies it without releasing it.
	if (isConstText(model, declaration.returns)) return { string: true };
	const free = releaseFunction(model, declaration);
	if (free === undefined) return undefined;
	const bytes = isByteType(target);
	const countName = bytes ? BYTE_COUNT_NAME : COUNT_NAME;
	const counts = declaration.params.filter(
		(param) =>
			pointee(model, param.type)?.kind === "integer" && countName.test(param.name ?? ""),
	);
	const count = counts.length === 1 ? counts[0]!.name : undefined;
	if (count !== undefined) {
		return bytes
			? { bytes: { length: count }, free }
			: { array: { length: count }, free };
	}
	return target.kind === "integer" && target.name === "char"
		? { string: true, free }
		: undefined;
}

/** A pointer type's spelling without `const`, which converts implicitly in C. */
function pointerSpelling(model: CModel, type: CType): string {
	return formatCDeclaration(resolveCType(model, type)).replaceAll("const ", "");
}

/**
 * The one function that returns a callback's user data from one of its parameters,
 * as `sqlite3_user_data(sqlite3_context *)` does, for callbacks without a `void *`.
 */
function lookupFunction(
	model: CModel,
	callback: Extract<CType, { kind: "function" }>,
): { function: string; param: string } | undefined {
	const found = model.functions.flatMap((declaration) => {
		const takes = declaration.params[0]?.type;
		if (
			declaration.params.length !== 1 ||
			takes === undefined ||
			pointee(model, takes) === undefined ||
			!isVoidPointer(model, declaration.returns)
		)
			return [];
		const param = callback.params.findIndex(
			(type) => pointerSpelling(model, type) === pointerSpelling(model, takes),
		);
		return param < 0 ? [] : [{ function: declaration.name, param: String(param + 1) }];
	});
	return found.length === 1 ? found[0] : undefined;
}

/**
 * Facts for a callback's buffer and array parameters, following the C convention of
 * a count just before the pointer, as in `(int n, const void *bytes)`. The first
 * `void *` is the user data.
 */
function callbackParameterFacts(
	model: CModel,
	callback: Extract<CType, { kind: "function" }>,
): Record<string, MaligatorFfiValueFacts> | undefined {
	const facts: Record<string, MaligatorFfiValueFacts> = {};
	let data = false;
	callback.params.forEach((param, position) => {
		const target = pointee(model, param);
		if (target === undefined || target.kind === "function") return;
		if (target.kind === "void" && !data) {
			data = true;
			return;
		}
		// Text and handles map without a count.
		if (target.kind === "integer" && target.name === "char" && target.const === true)
			return;
		const count =
			position > 0 ? resolveCType(model, callback.params[position - 1]!) : undefined;
		if (count?.kind !== "integer" || facts[String(position)] !== undefined) return;
		facts[String(position + 1)] = isByteType(target)
			? { bytes: { length: String(position) } }
			: { array: { length: String(position) } };
	});
	return Object.keys(facts).length === 0 ? undefined : facts;
}

function suggestFunction(
	model: CModel,
	declaration: CFunction,
	gaps: ReadonlyArray<Gap>,
): MaligatorFfiFunctionFacts | undefined {
	const key = (index: number): string =>
		declaration.params[index]!.name ?? String(index + 1);
	const params: Record<string, MaligatorFfiValueFacts> = {};
	const taken = new Set<number>();
	// Destructor parameters, `void (*)(void *)`, which release a callback's user data.
	// A lone function pointer is the callback itself, whatever its signature.
	const functionPointers = declaration.params.flatMap((param, position) =>
		pointee(model, param.type)?.kind === "function" ? [position] : [],
	);
	const releases =
		functionPointers.length < 2
			? []
			: functionPointers.filter((position) => {
					const target = pointee(model, declaration.params[position]!.type);
					return (
						target?.kind === "function" &&
						target.params.length === 1 &&
						isVoidPointer(model, target.params[0]!) &&
						resolveCType(model, target.returns).kind === "void"
					);
				});
	const result = resolveCType(model, declaration.returns);
	const setter = declaration.name
		.split(/_|(?<=[a-z\d])(?=[A-Z])/)
		.some((word) => SETTER_WORDS.has(word.toLowerCase()));
	// A setter may return the callback it replaces, or that callback's user data.
	const returnsPrevious = (callback: number, data: boolean): boolean =>
		result.kind === "pointer" &&
		((data && isVoidPointer(model, result)) ||
			formatCDeclaration(result) ===
				formatCDeclaration(resolveCType(model, declaration.params[callback]!.type)));
	const returns = gaps.some((gap) => gap.at === "return")
		? suggestResult(model, declaration)
		: undefined;
	if (returns !== undefined) {
		const counted = returns.bytes?.length ?? returns.array?.length;
		const index = declaration.params.findIndex((param) => param.name === counted);
		if (index >= 0) taken.add(index);
	}
	for (const index of gaps.flatMap((gap) => gap.param ?? [])) {
		const target = pointee(model, declaration.params[index]!.type);
		if (target === undefined || taken.has(index)) continue;
		if (target.kind === "function") {
			if (releases.includes(index)) continue;
			const data = declaration.params.flatMap((param, position) =>
				position !== index && !taken.has(position) && isVoidPointer(model, param.type)
					? [position]
					: [],
			);
			const receivesData = target.params.some((param) => isVoidPointer(model, param));
			// A `void (*)(void *)` after the data it takes destroys that data, as
			// `sqlite3_bind_blob`'s does; a callback comes before its user data.
			const destructor =
				target.params.length === 1 &&
				receivesData &&
				resolveCType(model, target.returns).kind === "void" &&
				data.length === 1 &&
				data[0]! < index;
			if (destructor) continue;
			const lookup =
				data.length === 1 && !receivesData ? lookupFunction(model, target) : undefined;
			const routed = data.length === 1 && (receivesData || lookup !== undefined);
			// Without user data, only names that say the library calls the function during
			// the call, as `qsort` does its comparator, make a call-scoped callback: others,
			// such as libuv's completion callbacks, run later.
			const scoped =
				data.length === 0 &&
				!receivesData &&
				[
					...nameWords(declaration.name),
					...nameWords(declaration.params[index]!.name ?? ""),
				].some((word) => SCOPED_WORDS.has(word));
			// A lone destructor for the user data means the library keeps the callback.
			const release = routed && releases.length === 1 ? releases[0] : undefined;
			const replaced =
				release === undefined && (setter || returnsPrevious(index, routed));
			if (!routed && !replaced && !scoped) continue;
			const counted = callbackParameterFacts(model, target);
			params[key(index)] = {
				// Setters conventionally take null to remove the callback.
				...(replaced ? { nullable: true } : {}),
				callback: {
					...(routed ? { data: key(data[0]!) } : {}),
					...(release === undefined ? {} : { release: key(release) }),
					...(replaced ? { replaced: true } : {}),
					...(lookup === undefined ? {} : { lookup }),
					...(counted === undefined ? {} : { params: counted }),
				},
			};
			if (routed) taken.add(data[0]!);
			if (release !== undefined) taken.add(release);
			continue;
		}
		const bytes = isByteType(target);
		const count = countParameter(model, declaration, index, taken, bytes);
		if (count !== undefined) {
			taken.add(count);
			params[key(index)] = bytes
				? { bytes: { length: key(count) } }
				: { array: { length: key(count) } };
			continue;
		}
		if (isConstText(model, declaration.params[index]!.type)) {
			params[key(index)] = { string: true };
			continue;
		}
		// Other character pointers are text or buffers, and a release function's pointer
		// is memory it frees, not a value it writes.
		if (
			bytes ||
			("const" in target && target.const === true) ||
			RELEASE_NAME.test(declaration.name)
		)
			continue;
		// A struct the function receives first is usually the one it updates.
		params[key(index)] =
			index === 0 && target.kind === "record" ? { inout: true } : { out: true };
	}
	if (Object.keys(params).length === 0)
		return returns === undefined ? undefined : { returns };
	return returns === undefined ? { params } : { params, returns };
}

function mergeFacts(
	facts: LibraryFacts,
	types: ReadonlyMap<string, MaligatorFfiTypeFacts>,
	functions: ReadonlyMap<string, MaligatorFfiFunctionFacts>,
): LibraryFacts {
	const merged: Record<string, MaligatorFfiFunctionFacts> = { ...facts.functions };
	for (const [name, suggested] of functions) {
		const stated = merged[name];
		merged[name] = {
			...stated,
			params: { ...stated?.params, ...suggested.params },
			returns: { ...stated?.returns, ...suggested.returns },
		};
	}
	return {
		...facts,
		types: { ...facts.types, ...Object.fromEntries(types) },
		functions: merged,
	};
}

function handleNames(binding: BoundFunction): Array<string> {
	const names = (value: JsValue | "data" | "count"): Array<string> => {
		if (typeof value !== "object") return [];
		if (value.kind === "handle") return [value.name];
		if (value.kind === "tagged")
			return value.cases.flatMap((entry) => names(entry.value));
		if (value.kind === "sequence" || value.kind === "union") return names(value.of);
		return value.kind === "callback" ? value.params.flatMap(names) : [];
	};
	return [
		binding.returns,
		...binding.params.map((param) => param.value),
		...binding.outputs.map((output) => output.value),
	].flatMap(names);
}

/**
 * Plan with suggestions applied, collecting every rejected function in one run so
 * validation drops all their suggestions before planning again.
 */
function planWithSuggestions(
	model: CModel,
	facts: LibraryFacts,
	types: ReadonlyMap<string, MaligatorFfiTypeFacts>,
	functions: ReadonlyMap<string, MaligatorFfiFunctionFacts>,
): { readonly plan: BindingPlan } | { readonly errors: ReadonlyArray<FfiError> } {
	const errors: Array<FfiFactError> = [];
	try {
		const plan = planBindings(model, mergeFacts(facts, types, functions), errors);
		return errors.length === 0 ? { plan } : { errors };
	} catch (error) {
		if (!(error instanceof FfiError)) throw error;
		return { errors: [...errors, error] };
	}
}

/**
 * Drop the suggestion behind each rejected fact: the entry that holds the fact, or the
 * suggested function whose planning reached it. False when a stated fact or an error
 * without a fact path remains unexplained.
 */
function dropRejected(
	errors: ReadonlyArray<FfiError>,
	types: Map<string, MaligatorFfiTypeFacts>,
	functions: Map<string, MaligatorFfiFunctionFacts>,
): boolean {
	const dropped = new Set<string>();
	let explained = true;
	for (const error of errors) {
		const entries =
			error instanceof FfiFactError
				? [
						error.entry,
						error.context === undefined ? undefined : factEntry(error.context),
					]
				: [];
		const rejected = entries.find((entry) => {
			if (entry === undefined) return false;
			const key = `${entry.section}.${entry.name}`;
			if (dropped.has(key)) return true;
			const suggestions =
				entry.section === "types"
					? types
					: entry.section === "functions"
						? functions
						: undefined;
			if (suggestions?.delete(entry.name) !== true) return false;
			dropped.add(key);
			return true;
		});
		if (rejected === undefined) explained = false;
	}
	return explained;
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
	return Object.fromEntries(
		[...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
	);
}

/**
 * Suggest facts for the declarations `plan` could not bind. Each suggestion is kept
 * only when a plan with every suggestion applied accepts it and binds the function
 * or uses the type.
 */
export function suggestFacts(
	model: CModel,
	facts: LibraryFacts,
	plan: BindingPlan,
): SuggestedFacts {
	const types = suggestHandles(model, plan);
	// Handle types change how pointers to them map, so function suggestions start from
	// the gaps that remain once the types apply.
	let typed: BindingPlan = plan;
	for (;;) {
		const trial = planWithSuggestions(model, facts, types, new Map());
		if ("plan" in trial) {
			typed = trial.plan;
			break;
		}
		if (dropRejected(trial.errors, types, new Map())) continue;
		types.clear();
		break;
	}
	const functions = new Map<string, MaligatorFfiFunctionFacts>();
	for (const entry of typed.unbound) {
		// Variants already carry their own facts.
		if (entry.global !== undefined || entry.name !== entry.declaration.name) continue;
		const suggested = suggestFunction(model, entry.declaration, entry.gaps);
		if (suggested !== undefined) functions.set(entry.name, suggested);
	}
	// A getter returns a resource the library keeps owning, such as the node
	// `xmlDocGetRootElement` returns, so closing it must not release it; unless its
	// documentation tells the caller to release it, as `cairo_mesh_pattern_get_path`'s does.
	const bound = new Set(plan.functions.map((binding) => binding.name));
	for (const binding of typed.functions) {
		if (binding.global !== undefined) continue;
		const result = binding.returns;
		const destroy =
			result.kind === "handle"
				? typed.handles.get(result.name)?.destroy?.name
				: undefined;
		const doc = binding.declaration.doc;
		if (
			!bound.has(binding.name) &&
			result.kind === "handle" &&
			result.owned &&
			destroy !== undefined &&
			!doc?.includes(destroy) &&
			!textMatches(doc, /\bcaller\b/i) &&
			nameWords(binding.name).includes("get")
		)
			functions.set(binding.name, { returns: { borrowed: true } });
	}
	for (;;) {
		const planned = planWithSuggestions(model, facts, types, functions);
		if ("errors" in planned) {
			if (dropRejected(planned.errors, types, functions)) continue;
			// A type suggestion broke a stated fact; suggest functions alone.
			if (types.size > 0) {
				types.clear();
				continue;
			}
			return { types: {}, functions: {}, binds: [] };
		}
		const trial = planned.plan;
		const before = new Set(plan.functions.map((binding) => binding.name));
		const newly = trial.functions.filter((binding) => !before.has(binding.name));
		const bound = new Set(newly.map((binding) => binding.name));
		const used = new Set(newly.flatMap(handleNames));
		return {
			types: sortedRecord([...types].filter(([name]) => used.has(name))),
			functions: sortedRecord([...functions].filter(([name]) => bound.has(name))),
			binds: [...bound].sort(),
		};
	}
}
