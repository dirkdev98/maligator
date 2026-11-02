import type { LibraryFacts } from "./contract.ts";

export function macroFactRoots(facts: LibraryFacts): Array<string> {
	const names = new Set<string>();
	for (const value of Object.values(facts.types)) {
		const destroy = value.handle?.destroy;
		if (typeof destroy === "object") names.add(destroy.success);
		for (const reference of value.evidence ?? [])
			if (reference.kind === "macro") names.add(reference.name);
	}
	for (const value of Object.values(facts.functions)) {
		for (const params of [
			value.params,
			...Object.values(value.variants ?? {}).map((variant) => variant.params),
		])
			for (const parameter of Object.values(params ?? {}))
				if (parameter.constant !== undefined) names.add(parameter.constant);
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
