export interface ModuleEvaluationNode {
	readonly path: string;
	readonly dependencies: ReadonlyArray<string>;
	readonly hasAwait: boolean;
}

export interface ModuleEvaluationPlan {
	readonly asynchronous: ReadonlySet<string>;
}

export function planModuleEvaluation(
	nodes: ReadonlyArray<ModuleEvaluationNode>,
): ModuleEvaluationPlan {
	const parents = new Map<string, Array<string>>();
	const asynchronous = new Set<string>();
	for (const node of nodes) {
		if (node.hasAwait) asynchronous.add(node.path);
		for (const dependency of node.dependencies) {
			const dependants = parents.get(dependency);
			if (dependants === undefined) parents.set(dependency, [node.path]);
			else dependants.push(node.path);
		}
	}
	const pending = [...asynchronous];
	for (let index = 0; index < pending.length; index++) {
		for (const parent of parents.get(pending[index]!) ?? []) {
			if (asynchronous.has(parent)) continue;
			asynchronous.add(parent);
			pending.push(parent);
		}
	}
	return { asynchronous };
}
