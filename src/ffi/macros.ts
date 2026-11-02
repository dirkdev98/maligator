import type { MaligatorFfiShape, MaligatorFfiValueFacts } from "../public-api.d.ts";
import type { LibraryFacts } from "./contract.ts";

export function macroFactRoots(facts: LibraryFacts): Array<string> {
	const names = new Set<string>();
	const shape = (value: MaligatorFfiShape | undefined): void => {
		if (value !== undefined && "tag" in value)
			for (const key of Object.keys(value.cases)) names.add(key);
	};
	const valueFacts = (value: MaligatorFfiValueFacts | undefined): void => {
		if (value === undefined) return;
		shape(value.shape);
		for (const parameter of Object.values(value.callback?.params ?? {}))
			valueFacts(parameter);
		valueFacts(value.callback?.returns);
	};
	for (const value of Object.values(facts.types)) {
		shape(value.shape);
		const destroy = value.handle?.destroy;
		if (typeof destroy === "object") names.add(destroy.success);
		for (const reference of value.evidence ?? [])
			if (reference.kind === "macro") names.add(reference.name);
	}
	for (const value of Object.values(facts.functions)) {
		valueFacts(value.returns);
		for (const params of [
			value.params,
			...Object.values(value.variants ?? {}).map((variant) => variant.params),
		])
			for (const parameter of Object.values(params ?? {})) {
				valueFacts(parameter);
				if (parameter.constant !== undefined) names.add(parameter.constant);
			}
		for (const reference of value.evidence ?? [])
			if (reference.kind === "macro") names.add(reference.name);
	}
	return [...names].filter((name) => /^[A-Za-z_]\w*$/.test(name)).sort();
}

/** Quoted tokens, preprocessor numbers, and formal parameters do not name dependencies. */
export function macroReferences(
	body: string,
	parameters: ReadonlyArray<string> = [],
): Array<string> {
	const ignored = new Set(parameters);
	const names = new Set<string>();
	for (const token of body.matchAll(
		/(?:u8|[LuU])?"(?:\\.|[^"\\])*"|(?:u8|[LuU])?'(?:\\.|[^'\\])*'|(?:\d|\.\d)(?:(?:[eEpP][+-])|[\w.])*|([A-Za-z_]\w*)/g,
	))
		if (token[1] !== undefined && !ignored.has(token[1])) names.add(token[1]);
	return [...names];
}
