import type {
	MaligatorFfiFunctionFacts,
	MaligatorFfiTypeFacts,
	MaligatorFfiValueFacts,
} from "../public-api.d.ts";
import { planBindings } from "./binding-plan.ts";
import type { BindingPlan, BoundFunction, Gap } from "./binding-plan.ts";
import { resolveCType } from "./c-model.ts";
import type { CFunction, CModel, CRecord } from "./c-model.ts";
import type { CType } from "./c-type.ts";
import type { LibraryFacts } from "./contract.ts";
import { FfiError } from "./ffi-error.ts";

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

/**
 * A struct the library hands out and later releases: one function whose name says
 * it releases, that takes only the struct or its address and returns nothing.
 */
function suggestHandles(
	model: CModel,
	plan: BindingPlan,
): Map<string, MaligatorFfiTypeFacts> {
	const handles = new Map<string, MaligatorFfiTypeFacts>();
	for (const record of model.records.values()) {
		if (
			!record.library ||
			record.tag !== "struct" ||
			plan.handles.has(record.name) ||
			plan.records.has(record.name)
		)
			continue;
		const releases = model.functions.filter((declaration) => {
			const param = declaration.params[0];
			if (
				declaration.params.length !== 1 ||
				param === undefined ||
				resolveCType(model, declaration.returns).kind !== "void" ||
				!RELEASE_NAME.test(declaration.name)
			)
				return false;
			const target = pointee(model, param.type);
			return (
				recordOf(model, param.type) === record ||
				(target?.kind === "record" && model.records.get(target.name) === record)
			);
		});
		// Among several, such as `UnloadSound` and `UnloadSoundAlias`, the one named after the type.
		const named = releases.filter((declaration) =>
			declaration.name.toLowerCase().endsWith(record.name.toLowerCase()),
		);
		const release =
			releases.length === 1 ? releases[0] : named.length === 1 ? named[0] : undefined;
		if (release !== undefined) {
			handles.set(record.name, { handle: { destroy: release.name } });
		}
	}
	return handles;
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
	const candidates = declaration.params.flatMap((param, position) =>
		position !== index &&
		!taken.has(position) &&
		resolveCType(model, param.type).kind === "integer"
			? [{ position, name: (param.name ?? "").toLowerCase() }]
			: [],
	);
	// A name built on the pointer's, such as `points` and `pointCount`, wins over position.
	const named = candidates.find(
		(candidate) =>
			stem !== "" && candidate.name.startsWith(stem) && countName.test(candidate.name),
	);
	if (named !== undefined) return named.position;
	const next = candidates.find((candidate) => candidate.position === index + 1);
	return next !== undefined &&
		(countName.test(next.name) || (!bytes && next.name === "n"))
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
	const doc = declaration.doc ?? "";
	return doc.includes(release) || /\bfree(?:s|d)?\b/i.test(doc) ? release : undefined;
}

/** A copied result: text, or bytes or elements counted through an out parameter. */
function suggestResult(
	model: CModel,
	declaration: CFunction,
): MaligatorFfiValueFacts | undefined {
	const target = pointee(model, declaration.returns);
	if (target === undefined || target.kind === "function") return undefined;
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

function parameterIndex(gap: Gap): number | undefined {
	const match = /^param (\d+) /.exec(gap.at);
	return match === null ? undefined : Number(match[1]) - 1;
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
	const returns = gaps.some((gap) => gap.at === "return")
		? suggestResult(model, declaration)
		: undefined;
	if (returns !== undefined) {
		const counted = returns.bytes?.length ?? returns.array?.length;
		const index = declaration.params.findIndex((param) => param.name === counted);
		if (index >= 0) taken.add(index);
	}
	for (const index of gaps.flatMap((gap) => parameterIndex(gap) ?? [])) {
		const target = pointee(model, declaration.params[index]!.type);
		if (target === undefined || taken.has(index)) continue;
		if (target.kind === "function") {
			const data = declaration.params.flatMap((param, position) =>
				position !== index && !taken.has(position) && isVoidPointer(model, param.type)
					? [position]
					: [],
			);
			if (
				data.length === 1 &&
				target.params.some((param) => isVoidPointer(model, param))
			) {
				params[key(index)] = { callback: { data: key(data[0]!) } };
				taken.add(data[0]!);
			}
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
		// Character pointers are text or buffers, and a release function's pointer is
		// memory it frees, not a value it writes.
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
	return { types: { ...facts.types, ...Object.fromEntries(types) }, functions: merged };
}

function handleNames(binding: BoundFunction): Array<string> {
	return [
		binding.returns,
		...binding.params.map((param) => param.value),
		...binding.outputs.map((output) => output.value),
	].flatMap((value) => (value.kind === "handle" ? [value.name] : []));
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
	try {
		typed = planBindings(model, mergeFacts(facts, types, new Map()));
	} catch (error) {
		if (!(error instanceof FfiError)) throw error;
		types.clear();
	}
	const functions = new Map<string, MaligatorFfiFunctionFacts>();
	for (const entry of typed.unbound) {
		// Variants already carry their own facts.
		if (entry.name !== entry.declaration.name) continue;
		const suggested = suggestFunction(model, entry.declaration, entry.gaps);
		if (suggested !== undefined) functions.set(entry.name, suggested);
	}
	for (;;) {
		let trial: BindingPlan;
		try {
			trial = planBindings(model, mergeFacts(facts, types, functions));
		} catch (error) {
			if (!(error instanceof FfiError)) throw error;
			// Facts errors name their path; drop the suggestion the planner rejected.
			const match = /^(types|functions)\.([^.:]+)/.exec(error.message);
			const rejected = match === null ? undefined : match[2]!;
			if (match?.[1] === "types" && rejected !== undefined && types.delete(rejected))
				continue;
			if (
				match?.[1] === "functions" &&
				rejected !== undefined &&
				functions.delete(rejected)
			)
				continue;
			// A type suggestion broke a stated fact; suggest functions alone.
			if (types.size > 0) {
				types.clear();
				continue;
			}
			return { types: {}, functions: {}, binds: [] };
		}
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
