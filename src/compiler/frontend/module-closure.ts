import type { ModuleRecord } from "./module-graph.ts";

/** The modules `from` loads and links before it runs: its static imports, transitively. */
export function staticModuleClosure(
	modules: ReadonlyMap<string, ModuleRecord>,
	from: string,
): Set<string> {
	const reached = new Set<string>();
	const pending = [from];
	for (
		let modulePath = pending.pop();
		modulePath !== undefined;
		modulePath = pending.pop()
	) {
		if (reached.has(modulePath)) continue;
		reached.add(modulePath);
		for (const dependency of modules.get(modulePath)?.dependencies ?? [])
			if (
				dependency.resolvedPath !== null &&
				dependency.kind !== "dynamic" &&
				dependency.kind !== "worker"
			)
				pending.push(dependency.resolvedPath);
	}
	return reached;
}
