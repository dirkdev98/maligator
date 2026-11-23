export function controlFlowCycles(
	successors: ReadonlyArray<ReadonlyArray<number>>,
	entry: number,
): { readonly reachable: Uint8Array; readonly repeating: Uint8Array } {
	const count = successors.length;
	const predecessors: Array<Array<number>> = Array.from({ length: count }, () => []);
	const reachable = new Uint8Array(count);
	const cursor = new Uint32Array(count);
	const postorder: Array<number> = [];
	const work = [entry];
	reachable[entry] = 1;
	while (work.length > 0) {
		const block = work[work.length - 1]!;
		const next = successors[block]!;
		if (cursor[block]! === next.length) {
			postorder.push(work.pop()!);
			continue;
		}
		const target = next[cursor[block]!++]!;
		predecessors[target]!.push(block);
		if (reachable[target] === 0) {
			reachable[target] = 1;
			work.push(target);
		}
	}

	const assigned = new Uint8Array(count);
	const repeating = new Uint8Array(count);
	for (let index = postorder.length - 1; index >= 0; index--) {
		const start = postorder[index]!;
		if (assigned[start] !== 0) continue;
		assigned[start] = 1;
		const component: Array<number> = [];
		work.push(start);
		while (work.length > 0) {
			const block = work.pop()!;
			component.push(block);
			for (const previous of predecessors[block]!) {
				if (assigned[previous] !== 0) continue;
				assigned[previous] = 1;
				work.push(previous);
			}
		}
		if (component.length > 1 || successors[start]!.includes(start))
			for (const block of component) repeating[block] = 1;
	}
	return { reachable, repeating };
}
