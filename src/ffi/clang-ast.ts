import type { Buffer } from "node:buffer";
import { FfiJsonReader } from "./json.ts";

type JsonObject = Record<string, unknown>;

function declaration(
	reader: FfiJsonReader,
	start: number,
): { node: JsonObject; end: number } {
	const { value, end } = reader.value(start);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return reader.malformed(start);
	return { node: value as JsonObject, end };
}

/** Decode containers separately so an aggregate AST never becomes one engine string. */
export function visitClangDeclarations(
	data: Buffer,
	visit: (node: JsonObject) => void,
): void {
	const reader = new FfiJsonReader(data, "clang AST");
	let offset = reader.whitespace(0);
	if (data[offset] !== 123) return reader.malformed(offset);
	offset = reader.whitespace(offset + 1);
	const keys = new Set<string>();
	let translationUnit = false;
	for (;;) {
		if (data[offset] !== 34) return reader.malformed(offset);
		const { value: key, end: keyEnd } = reader.value(offset);
		if (typeof key !== "string" || keys.has(key)) return reader.malformed(offset);
		keys.add(key);
		offset = reader.whitespace(keyEnd);
		if (data[offset] !== 58) return reader.malformed(offset);
		offset = reader.whitespace(offset + 1);
		if (key === "inner") {
			if (data[offset] !== 91) return reader.malformed(offset);
			offset = reader.whitespace(offset + 1);
			if (data[offset] !== 93) {
				for (;;) {
					const { node, end } = declaration(reader, offset);
					visit(node);
					offset = reader.whitespace(end);
					if (data[offset] === 93) break;
					if (data[offset] !== 44) return reader.malformed(offset);
					offset = reader.whitespace(offset + 1);
				}
			}
			offset++;
		} else {
			const { value, end } = reader.value(offset);
			if (key === "kind") {
				if (value !== "TranslationUnitDecl") return reader.malformed(offset);
				translationUnit = true;
			}
			offset = end;
		}
		offset = reader.whitespace(offset);
		if (data[offset] === 125) {
			offset = reader.whitespace(offset + 1);
			break;
		}
		if (data[offset] !== 44) return reader.malformed(offset);
		offset = reader.whitespace(offset + 1);
	}
	if (offset !== data.length || !translationUnit || !keys.has("inner"))
		reader.malformed(offset);
}

/** Clang's filtered dump concatenates complete JSON declarations without an array. */
export function visitClangProbeDeclarations(
	data: Buffer,
	visit: (node: JsonObject) => void,
): void {
	const reader = new FfiJsonReader(data, "clang AST");
	let offset = reader.whitespace(0);
	while (offset < data.length) {
		const { node, end } = declaration(reader, offset);
		visit(node);
		offset = reader.whitespace(end);
	}
}

export function clangProbeDeclarations(data: Buffer): ReadonlyArray<JsonObject> {
	const nodes: Array<JsonObject> = [];
	visitClangProbeDeclarations(data, (node) => nodes.push(node));
	return nodes;
}
