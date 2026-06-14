import type { ESTree } from "meriyah";

/**
 * Collect the unsupported language constructs used in an AST.
 *
 * The tracing compiler silently skips most constructs it cannot lower, which
 * would otherwise turn into vacuously passing or crashing programs. Scanning
 * upfront turns those into an explicit UNSUPPORTED verdict and doubles as a
 * priority ranking for which features block the most tests.
 */
export function collectUnsupportedSyntax(
	node: ESTree.Node,
	{ isModule = false }: { isModule?: boolean } = {},
): Set<string> {
	const unsupported = new Set<string>();
	walk(node, unsupported, { inArrowFunction: false, inAsyncFunction: false, isModule });
	return unsupported;
}

interface WalkContext {
	inArrowFunction: boolean;
	inAsyncFunction: boolean;
	/** Module goal: top-level await is allowed. */
	isModule: boolean;
}

function walk(value: unknown, unsupported: Set<string>, context: WalkContext) {
	if (Array.isArray(value)) {
		for (const entry of value) {
			walk(entry, unsupported, context);
		}
		return;
	}

	if (!value || typeof value !== "object" || !("type" in value)) {
		return;
	}

	const node = value as ESTree.Node;

	switch (node.type) {
		case "Literal": {
			if ("regex" in node && node.regex) {
				unsupported.add("regex literal");
			}
			break;
		}
		default:
			break;
	}

	for (const key of Object.keys(node)) {
		walk((node as unknown as Record<string, unknown>)[key], unsupported, context);
	}
}
