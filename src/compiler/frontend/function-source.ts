import type { ESTree } from "meriyah";
import { forEachEstreeChild } from "./estree-traversal.ts";
import type { SemanticFile } from "./semantic-analysis.ts";

interface Span {
	start: number;
	end: number;
}
interface FileSpans {
	text: string;
	spans: Map<ESTree.Node, Span>;
}
const cachedSpans = new WeakMap<SemanticFile, FileSpans>();

function afterStatic(text: string, start: number, end: number): number {
	let index = start + "static".length;
	while (index < end) {
		if (text[index]!.trim().length === 0) {
			index++;
			continue;
		}
		if (text.startsWith("/*", index)) {
			const close = text.indexOf("*/", index + 2);
			index = close < 0 ? end : close + 2;
			continue;
		}
		if (text.startsWith("//", index)) {
			index += 2;
			while (index < end && ![10, 13, 0x2028, 0x2029].includes(text.charCodeAt(index)))
				index++;
			continue;
		}
		break;
	}
	return index;
}

function collect(file: SemanticFile): FileSpans {
	const text = file.parsedSource ?? file.contents;
	const offsets = [0];
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
		if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029)
			offsets.push(index + 1);
	}
	const spans = new Map<ESTree.Node, Span>();
	const remember = (
		node: ESTree.Node,
		source: ESTree.Node,
		staticMethod = false,
	): void => {
		if (source.loc === undefined || source.loc === null) return;
		const first = offsets[source.loc.start.line - 1];
		const last = offsets[source.loc.end.line - 1];
		if (first === undefined || last === undefined) return;
		let start = first + source.loc.start.column;
		const end = last + source.loc.end.column;
		if (start < 0 || end > text.length || end <= start) return;
		if (staticMethod) start = afterStatic(text, start, end);
		if (start < end) spans.set(node, { start, end });
	};
	const visit = (
		node: ESTree.Node,
		parent: ESTree.Node | undefined,
		currentClass: ESTree.ClassDeclaration | ESTree.ClassExpression | undefined,
	): void => {
		if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
			currentClass = node;
			remember(node, node);
		} else if (
			node.type === "FunctionDeclaration" ||
			node.type === "FunctionExpression" ||
			node.type === "ArrowFunctionExpression"
		) {
			if (parent?.type === "MethodDefinition" && parent.value === node) {
				if (parent.kind === "constructor" && currentClass !== undefined)
					remember(node, currentClass);
				else remember(node, parent, parent.static);
			} else if (
				parent?.type === "Property" &&
				parent.value === node &&
				(parent.method || parent.kind === "get" || parent.kind === "set")
			)
				remember(node, parent);
			else remember(node, node);
		}
		forEachEstreeChild(node, (child) => visit(child, node, currentClass));
	};
	visit(file.ast, undefined, undefined);
	return { text, spans };
}

/** Function reflection uses the parsed text; provenance can keep the original input. */
export function functionSource(
	file: SemanticFile,
	node: ESTree.Node,
): string | undefined {
	let cached = cachedSpans.get(file);
	if (cached === undefined) {
		cached = collect(file);
		cachedSpans.set(file, cached);
	}
	const span = cached.spans.get(node);
	return span === undefined ? undefined : cached.text.slice(span.start, span.end);
}
