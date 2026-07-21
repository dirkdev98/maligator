import type { ESTree } from "meriyah";

export const ESTREE_CONTINUE = "continue";
export const ESTREE_SKIP = "skip";
export const ESTREE_STOP = "stop";

export type EstreeTraversalAction =
	| typeof ESTREE_CONTINUE
	| typeof ESTREE_SKIP
	| typeof ESTREE_STOP;

export interface EstreeTraversalContext<Context> {
	readonly parent: ESTree.Node | null;
	readonly key: string | number | null;
	readonly context: Context;
}

export type EstreeVisitor<Context> = (
	node: ESTree.Node,
	at: EstreeTraversalContext<Context>,
) => EstreeTraversalAction | void;

export function isEstreeNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** Visit each direct ESTree child, ignoring metadata and other non-node objects. */
export function forEachEstreeChild(
	node: ESTree.Node,
	visit: (child: ESTree.Node, key: string | number) => void,
): void {
	for (const key of Object.keys(node)) {
		const value: unknown = (node as unknown as Record<string, unknown>)[key];
		if (isEstreeNode(value)) {
			visit(value, key);
		} else if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				const item: unknown = value[index];
				if (isEstreeNode(item)) visit(item, index);
			}
		}
	}
}

/**
 * Pre-order ESTree traversal. `skip` prunes one node's children and `stop`
 * terminates the entire traversal. Arrays may be used as traversal roots.
 */
export function traverseEstree<Context = undefined>(
	root: unknown,
	visitor: EstreeVisitor<Context>,
	context?: Context,
): typeof ESTREE_CONTINUE | typeof ESTREE_STOP {
	let stopped = false;

	const visit = (
		value: unknown,
		parent: ESTree.Node | null,
		key: string | number | null,
	): void => {
		if (stopped) return;
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length && !stopped; index++) {
				visit(value[index], parent, index);
			}
			return;
		}
		if (!isEstreeNode(value)) return;

		const action = visitor(value, {
			parent,
			key,
			context: context as Context,
		});
		if (action === ESTREE_STOP) {
			stopped = true;
			return;
		}
		if (action === ESTREE_SKIP) return;

		forEachEstreeChild(value, (child, childKey) => visit(child, value, childKey));
	};

	visit(root, null, null);
	return stopped ? ESTREE_STOP : ESTREE_CONTINUE;
}
