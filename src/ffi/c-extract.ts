import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolExecutable } from "../toolchain.ts";
import { clangMajorVersion, toolArguments } from "../toolchain.ts";
import type {
	CEnum,
	CEnumConstant,
	CField,
	CFunction,
	CLocation,
	CMacro,
	CModel,
	CParameter,
	CRecord,
	CTarget,
	CTypedef,
	CUntypedMacro,
} from "./c-model.ts";
import { resolveCType } from "./c-model.ts";
import { C_FLOAT_NAMES, C_INTEGER_NAMES, parseCType, unnamedTagKey } from "./c-type.ts";
import type { CType } from "./c-type.ts";
import { FfiError } from "./ffi-error.ts";

export interface CExtractionInput {
	/** A clang driver, or `zig cc`, which embeds clang. */
	readonly compiler: ToolExecutable;
	readonly environment: NodeJS.ProcessEnv;
	/** Header spellings as C code includes them, such as `raylib.h` or `curl/curl.h`. */
	readonly headers: ReadonlyArray<string>;
	/** Include directories and defines the library needs, as compiler arguments. */
	readonly compileArguments: ReadonlyArray<string>;
}

/** The C standard binding units compile with; headers must parse the same way. */
export const FFI_C_STANDARD = "-std=c2x";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(node: JsonObject, key: string): string | undefined {
	const value = node[key];
	return typeof value === "string" ? value : undefined;
}

function objectField(node: JsonObject, key: string): JsonObject | undefined {
	const value = node[key];
	return isObject(value) ? value : undefined;
}

function innerNodes(node: JsonObject): Array<JsonObject> {
	const inner = node.inner;
	return Array.isArray(inner) ? inner.filter(isObject) : [];
}

function runCompiler(
	input: CExtractionInput,
	args: ReadonlyArray<string>,
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		input.compiler.path,
		toolArguments(input.compiler, [...args]),
		{
			env: input.environment,
			encoding: "utf-8",
			maxBuffer: 1 << 30,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (result.error !== undefined) {
		throw new FfiError(`cannot run ${input.compiler.path}: ${result.error.message}`);
	}
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertClang(compiler: ToolExecutable): void {
	if (
		clangMajorVersion(compiler.version) === undefined &&
		!compiler.version.startsWith("zig cc")
	) {
		throw new FfiError(
			`header extraction needs clang, but CC is '${compiler.version}'; set CC to a clang compiler`,
		);
	}
}

interface PreprocessedMacro {
	readonly name: string;
	readonly body: string;
	readonly functionLike: boolean;
	readonly file: string;
	readonly line: number;
}

interface Preprocessed {
	readonly headerPaths: ReadonlyArray<string>;
	readonly files: ReadonlySet<string>;
	readonly macros: ReadonlyMap<string, PreprocessedMacro>;
}

const LINE_MARKER = /^# (\d+) "((?:[^"\\]|\\.)*)"((?: \d+)*)$/;
const DEFINE = /^#define ([A-Za-z_]\w*)(\()?(.*)$/;

function unescapeMarkerPath(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

function isPseudoFile(file: string): boolean {
	return file.startsWith("<") && file.endsWith(">");
}

function preprocess(
	input: CExtractionInput,
	probePath: string,
	cwd: string,
): Preprocessed {
	const result = runCompiler(input, [
		FFI_C_STANDARD,
		"-E",
		"-dD",
		"-w",
		...input.compileArguments,
		"-x",
		"c",
		probePath,
	]);
	if (result.status !== 0) {
		throw new FfiError(`cannot preprocess the library headers:\n${result.stderr.trim()}`);
	}
	const stack: Array<string> = [];
	const directIncludes: Array<string> = [];
	const files = new Set<string>();
	const macros = new Map<string, PreprocessedMacro>();
	let file = "";
	let line = 0;
	for (const text of result.stdout.split("\n")) {
		const marker = LINE_MARKER.exec(text);
		if (marker !== null) {
			const name = unescapeMarkerPath(marker[2]!);
			const flags = marker[3]!.trim().split(/\s+/).filter(Boolean);
			if (flags.includes("1")) {
				if (stack.at(-1) === probePath) directIncludes.push(path.resolve(cwd, name));
				stack.push(name);
			} else if (flags.includes("2")) {
				while (stack.length > 0 && stack.at(-1) !== name) stack.pop();
				if (stack.length === 0) stack.push(name);
			} else if (stack.length === 0) stack.push(name);
			else stack[stack.length - 1] = name;
			if (!isPseudoFile(name)) files.add(path.resolve(cwd, name));
			file = name;
			line = Number(marker[1]);
			continue;
		}
		const define = DEFINE.exec(text);
		if (define !== null) {
			macros.set(define[1]!, {
				name: define[1]!,
				body: define[3]!.trim(),
				functionLike: define[2] !== undefined,
				file,
				line,
			});
		} else if (text.startsWith("#undef ")) {
			macros.delete(text.slice("#undef ".length).trim());
		}
		line++;
	}
	files.delete(probePath);
	const headerPaths = input.headers.map((spelling) => {
		const suffix = `${path.sep}${path.normalize(spelling)}`;
		const resolved =
			directIncludes.find((candidate) => candidate.endsWith(suffix)) ??
			[...files].find((candidate) => candidate.endsWith(suffix));
		if (resolved === undefined) {
			throw new FfiError(`cannot locate header '${spelling}' among the included files`);
		}
		return resolved;
	});
	return { headerPaths, files, macros };
}

/**
 * Files whose declarations belong to the library: each listed header, plus the
 * directory of a namespaced header such as `curl/curl.h`. A bare header like
 * `raylib.h` usually sits in a shared include root, so its siblings are not claimed.
 */
function libraryFileFilter(
	headers: ReadonlyArray<string>,
	headerPaths: ReadonlyArray<string>,
): (file: string) => boolean {
	const files = new Set(headerPaths);
	const directories = headers.flatMap((spelling, index) =>
		path.normalize(spelling).includes(path.sep)
			? [path.dirname(headerPaths[index]!)]
			: [],
	);
	return (file) =>
		files.has(file) ||
		directories.some((directory) => file.startsWith(directory + path.sep));
}

/**
 * Clang's JSON omits a location's file and line when they repeat the previously
 * written location, in output order across the whole dump. Replaying that order
 * restores both on every location object as `$file` and `$line`.
 */
function resolveLocations(root: unknown): void {
	let file: string | undefined;
	let line: number | undefined;
	const bare = (location: unknown): void => {
		if (!isObject(location)) return;
		if (typeof location.file === "string") file = location.file;
		if (typeof location.line === "number") line = location.line;
		location.$file = file;
		location.$line = line;
	};
	const visitLocation = (location: unknown): void => {
		if (!isObject(location) || Object.keys(location).length === 0) return;
		if ("spellingLoc" in location || "expansionLoc" in location) {
			for (const key of Object.keys(location)) {
				if (key === "spellingLoc" || key === "expansionLoc") bare(location[key]);
			}
			const expansion = objectField(location, "expansionLoc");
			location.$file = expansion?.$file;
			location.$line = expansion?.$line;
			return;
		}
		bare(location);
	};
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isObject(node)) return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "loc") visitLocation(value);
			else if (key === "range" && isObject(value)) {
				visitLocation(value.begin);
				visitLocation(value.end);
			} else if (key !== "includedFrom") visit(value);
		}
	};
	visit(root);
}

interface NodeLocation {
	/** The file as clang spells it, which is what unnamed tag spellings use. */
	readonly rawFile: string;
	readonly file: string;
	readonly line: number;
	readonly column: number;
	/** The column just past the location's token. */
	readonly end: number;
}

function locationOf(location: unknown, cwd: string): NodeLocation | undefined {
	if (!isObject(location)) return undefined;
	const file = location.$file;
	const line = location.$line;
	if (typeof file !== "string" || typeof line !== "number") return undefined;
	const point = objectField(location, "expansionLoc") ?? location;
	const column = typeof point.col === "number" ? point.col : 1;
	const tokenLength = typeof point.tokLen === "number" ? point.tokLen : 0;
	return {
		rawFile: file,
		file: path.resolve(cwd, file),
		line,
		column,
		end: column + tokenLength,
	};
}

interface DeclarationSpan {
	readonly location: NodeLocation;
	readonly begin: NodeLocation;
	readonly end: NodeLocation;
}

function spanOf(node: JsonObject, cwd: string): DeclarationSpan | undefined {
	const location = locationOf(node.loc, cwd);
	const range = objectField(node, "range");
	const begin = locationOf(range?.begin, cwd) ?? location;
	const end = locationOf(range?.end, cwd) ?? location;
	if (location === undefined || begin === undefined || end === undefined)
		return undefined;
	return { location, begin, end };
}

function nodeType(node: JsonObject): CType {
	const type = objectField(node, "type");
	const spelling = type === undefined ? undefined : stringField(type, "qualType");
	if (spelling === undefined) return { kind: "unsupported", spelling: "" };
	const parsed = parseCType(spelling);
	if (parsed.kind !== "unsupported") return parsed;
	const desugared =
		type === undefined ? undefined : stringField(type, "desugaredQualType");
	return desugared === undefined ? parsed : parseCType(desugared);
}

/**
 * The evaluated initializer of an enum constant or bit-field width. Every probe
 * picks an underlying type that preserves the value, so implicit conversions
 * around the evaluated expression can be looked through.
 */
function constantValue(node: JsonObject): bigint | undefined {
	for (let child of innerNodes(node)) {
		while (child.kind === "ImplicitCastExpr" && innerNodes(child).length === 1) {
			child = innerNodes(child)[0]!;
		}
		if (child.kind === "ConstantExpr" && typeof child.value === "string") {
			return BigInt(child.value);
		}
	}
	return undefined;
}

class SourceTexts {
	readonly #files = new Map<string, ReadonlyArray<string>>();

	lines(file: string): ReadonlyArray<string> {
		let lines = this.#files.get(file);
		if (lines === undefined) {
			try {
				lines = readFileSync(file, "utf-8").split("\n");
			} catch {
				lines = [];
			}
			this.#files.set(file, lines);
		}
		return lines;
	}
}

/** Remove comment markers and decorative rules, keeping the prose lines. */
function cleanComment(raw: ReadonlyArray<string>): string | undefined {
	const lines = raw
		.map((line) =>
			line
				.trim()
				.replace(/^\/\*+!?/, "")
				.replace(/\*+\/$/, "")
				.replace(/^\/\/[/!<]?/, "")
				.replace(/^\*+(?!\/)/, "")
				.trim(),
		)
		.filter((line) => !/^[-=*#/~_+]{3,}$/.test(line));
	while (lines[0] === "") lines.shift();
	while (lines.at(-1) === "") lines.pop();
	return lines.length === 0 ? undefined : lines.join("\n");
}

/** A comment that follows only closing punctuation after `column` on `line`. */
function trailingComment(
	lines: ReadonlyArray<string>,
	line: number,
	column: number,
): string | undefined {
	const text = lines[line - 1];
	if (text === undefined) return undefined;
	const rest = text.slice(Math.max(0, column - 1));
	const match = /^[\s;,)]*(\/\/.*|\/\*.*)$/.exec(rest);
	if (match === null) return undefined;
	const comment = match[1]!;
	if (comment.startsWith("//")) return cleanComment([comment]);
	const block = [comment];
	for (let index = line; !block.at(-1)!.includes("*/") && index < lines.length; index++) {
		block.push(lines[index]!);
	}
	return cleanComment(block);
}

/** The comment after a `#define` on `line`, skipping string and character literals. */
function macroComment(lines: ReadonlyArray<string>, line: number): string | undefined {
	const text = lines[line - 1];
	if (text === undefined) return undefined;
	let quote: string | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote !== undefined) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (text.startsWith("//", index) || text.startsWith("/*", index)) {
			return trailingComment(lines, line, index + 1);
		}
	}
	return undefined;
}

/** The comment block whose last line sits directly above `line`. */
function commentBlockAbove(
	lines: ReadonlyArray<string>,
	line: number,
): { text: string | undefined } | undefined {
	const above = lines[line - 2]?.trim();
	if (above === undefined) return undefined;
	if (above.startsWith("//")) {
		const block: Array<string> = [];
		for (
			let index = line - 2;
			index >= 0 && lines[index]!.trim().startsWith("//");
			index--
		) {
			block.unshift(lines[index]!);
		}
		return { text: cleanComment(block) };
	}
	if (above.endsWith("*/")) {
		const block: Array<string> = [];
		for (let index = line - 2; index >= 0; index--) {
			block.unshift(lines[index]!);
			const trimmed = lines[index]!.trim();
			if (trimmed.startsWith("/*")) return { text: cleanComment(block) };
			if (trimmed.includes("/*")) return undefined;
		}
	}
	return undefined;
}

interface DocumentedSpan {
	readonly begin: number;
	readonly end: number;
	readonly trailing: boolean;
}

/**
 * Documentation for a declaration: a trailing comment on its last line, otherwise
 * the comment block above it. Undocumented sibling declarations between the two
 * share that block, which is how SQLite documents a group of functions.
 */
class Documentation {
	readonly #sources = new SourceTexts();
	readonly #spans = new Map<string, Array<DocumentedSpan>>();

	trailing(location: NodeLocation): string | undefined {
		return trailingComment(
			this.#sources.lines(location.file),
			location.line,
			location.end,
		);
	}

	record(file: string, span: DocumentedSpan): void {
		let spans = this.#spans.get(file);
		if (spans === undefined) {
			spans = [];
			this.#spans.set(file, spans);
		}
		spans.push(span);
	}

	declaration(span: DeclarationSpan): string | undefined {
		const trailing = this.trailing(span.end);
		if (trailing !== undefined) return trailing;
		const lines = this.#sources.lines(span.begin.file);
		const siblings = this.#spans.get(span.begin.file) ?? [];
		let line = span.begin.line;
		for (;;) {
			const block = commentBlockAbove(lines, line);
			if (block !== undefined) return block.text;
			const sibling = siblings.find(
				(candidate) => candidate.end === line - 1 && !candidate.trailing,
			);
			if (sibling === undefined) return undefined;
			line = sibling.begin;
		}
	}
}

function attributeKinds(node: JsonObject): Array<string> {
	return innerNodes(node)
		.map((child) => (typeof child.kind === "string" ? child.kind : ""))
		.filter((kind) => kind.endsWith("Attr"))
		.map((kind) => kind.slice(0, -"Attr".length));
}

interface Declarations {
	readonly functions: Array<CFunction>;
	readonly records: Map<string, CRecord>;
	readonly enums: Map<string, CEnum>;
	readonly typedefs: Map<string, CTypedef>;
}

function collectDeclarations(
	ast: JsonObject,
	cwd: string,
	isLibraryFile: (file: string) => boolean,
): Declarations {
	const documentation = new Documentation();
	const topLevel = innerNodes(ast).filter((node) => node.isImplicit !== true);

	// Spans first, so a declaration's documentation can see its later siblings too.
	for (const node of topLevel) {
		const span = spanOf(node, cwd);
		if (span === undefined || !isLibraryFile(span.begin.file)) continue;
		documentation.record(span.begin.file, {
			begin: span.begin.line,
			end: span.end.line,
			trailing: documentation.trailing(span.end) !== undefined,
		});
	}

	const records = new Map<string, CRecord>();
	const recordNodes = new Map<string, { node: JsonObject; key: string }>();
	const enums = new Map<string, CEnum>();
	const enumNodes = new Map<string, { node: JsonObject; key: string }>();
	const typedefs = new Map<string, CTypedef>();
	const functions = new Map<string, CFunction>();

	const isNamed = (node: JsonObject): node is JsonObject & { name: string } =>
		typeof node.name === "string" && node.name !== "";

	const recordKey = (node: JsonObject): string | undefined => {
		if (isNamed(node)) return node.name;
		const location = locationOf(node.loc, cwd);
		return location === undefined
			? undefined
			: unnamedTagKey(location.rawFile, location.line, location.column);
	};

	const registerRecord = (node: JsonObject, key: string): void => {
		const span = spanOf(node, cwd);
		if (span === undefined) return;
		const complete = node.completeDefinition === true;
		const existing = records.get(key);
		if (existing !== undefined && (existing.complete || !complete)) return;
		const library = isLibraryFile(span.location.file);
		const fields: Array<CField> = [];
		for (const child of innerNodes(node)) {
			if (child.kind === "RecordDecl") {
				const childKey = recordKey(child);
				if (childKey !== undefined) registerRecord(child, childKey);
				continue;
			}
			if (child.kind !== "FieldDecl") continue;
			const fieldSpan = spanOf(child, cwd);
			const bitWidth = child.isBitfield === true ? constantValue(child) : undefined;
			const doc =
				library && fieldSpan !== undefined
					? documentation.trailing(fieldSpan.end)
					: undefined;
			fields.push({
				...(typeof child.name === "string" && child.name !== ""
					? { name: child.name }
					: {}),
				type: nodeType(child),
				...(bitWidth === undefined ? {} : { bitWidth: Number(bitWidth) }),
				...(doc === undefined ? {} : { doc }),
			});
		}
		const doc = library ? documentation.declaration(span) : undefined;
		records.set(key, {
			name: key,
			tag: node.tagUsed === "union" ? "union" : "struct",
			complete,
			fields,
			named: isNamed(node),
			...(doc === undefined ? {} : { doc }),
			location: { file: span.location.file, line: span.location.line },
			library,
		});
	};

	const registerEnum = (node: JsonObject, key: string): void => {
		const span = spanOf(node, cwd);
		if (span === undefined) return;
		const library = isLibraryFile(span.location.file);
		const constants: Array<CEnumConstant> = [];
		let next = 0n;
		for (const child of innerNodes(node)) {
			if (child.kind !== "EnumConstantDecl" || typeof child.name !== "string") continue;
			const value = constantValue(child) ?? next;
			next = value + 1n;
			const childSpan = spanOf(child, cwd);
			const doc =
				library && childSpan !== undefined
					? documentation.trailing(childSpan.end)
					: undefined;
			constants.push({ name: child.name, value, ...(doc === undefined ? {} : { doc }) });
		}
		const fixed = objectField(node, "fixedUnderlyingType");
		const fixedSpelling =
			fixed === undefined ? undefined : stringField(fixed, "qualType");
		const doc = library ? documentation.declaration(span) : undefined;
		enums.set(key, {
			name: key,
			named: isNamed(node),
			underlying:
				fixedSpelling === undefined
					? { kind: "integer", name: "int" }
					: parseCType(fixedSpelling),
			constants,
			...(doc === undefined ? {} : { doc }),
			location: { file: span.location.file, line: span.location.line },
			library,
		});
	};

	for (const node of topLevel) {
		if (node.kind === "RecordDecl") {
			const key = recordKey(node);
			if (key === undefined) continue;
			if (typeof node.id === "string") recordNodes.set(node.id, { node, key });
			registerRecord(node, key);
		} else if (node.kind === "EnumDecl") {
			const key = recordKey(node);
			if (key === undefined) continue;
			if (typeof node.id === "string") enumNodes.set(node.id, { node, key });
			registerEnum(node, key);
		}
	}

	/** The record or enum declaration id a typedef's type tree names. */
	const typedefTarget = (node: JsonObject): string | undefined => {
		const pending = [...innerNodes(node)];
		while (pending.length > 0) {
			const child = pending.shift()!;
			if (child.kind === "RecordType" || child.kind === "EnumType") {
				const decl = objectField(child, "decl");
				return decl === undefined ? undefined : stringField(decl, "id");
			}
			pending.push(...innerNodes(child));
		}
		return undefined;
	};

	for (const node of topLevel) {
		if (node.kind === "TypedefDecl" && typeof node.name === "string") {
			const span = spanOf(node, cwd);
			if (span === undefined) continue;
			const library = isLibraryFile(span.location.file);
			const target = typedefTarget(node);
			// Clang spells an unnamed tag by its typedef name (`struct Vector2`).
			const unnamedRecord = target === undefined ? undefined : recordNodes.get(target);
			if (unnamedRecord !== undefined && !isNamed(unnamedRecord.node)) {
				const record = records.get(unnamedRecord.key);
				if (record !== undefined && !records.has(node.name)) {
					const doc =
						record.doc ?? (library ? documentation.declaration(span) : undefined);
					records.set(node.name, {
						...record,
						name: node.name,
						...(doc === undefined ? {} : { doc }),
					});
				}
			}
			const unnamedEnum = target === undefined ? undefined : enumNodes.get(target);
			if (unnamedEnum !== undefined && !isNamed(unnamedEnum.node)) {
				const entry = enums.get(unnamedEnum.key);
				if (entry !== undefined && !enums.has(node.name)) {
					enums.set(node.name, { ...entry, name: node.name });
				}
			}
			const doc = library ? documentation.declaration(span) : undefined;
			typedefs.set(node.name, {
				name: node.name,
				type: nodeType(node),
				...(doc === undefined ? {} : { doc }),
				location: { file: span.location.file, line: span.location.line },
				library,
			});
			continue;
		}
		if (node.kind !== "FunctionDecl" || typeof node.name !== "string") continue;
		const span = spanOf(node, cwd);
		if (span === undefined || !isLibraryFile(span.location.file)) continue;
		const type = nodeType(node);
		const params: Array<CParameter> = [];
		for (const child of innerNodes(node)) {
			if (child.kind !== "ParmVarDecl") continue;
			const childSpan = spanOf(child, cwd);
			const ownLine =
				childSpan !== undefined &&
				childSpan.end.line !== span.begin.line &&
				childSpan.end.line !== span.end.line;
			const doc = ownLine ? documentation.trailing(childSpan.end) : undefined;
			params.push({
				...(typeof child.name === "string" && child.name !== ""
					? { name: child.name }
					: {}),
				type: nodeType(child),
				...(doc === undefined ? {} : { doc }),
			});
		}
		const doc = documentation.declaration(span);
		functions.set(node.name, {
			name: node.name,
			returns:
				type.kind === "function" ? type.returns : { kind: "unsupported", spelling: "" },
			params,
			variadic: type.kind === "function" && type.variadic,
			inline: node.inline === true || node.storageClass === "static",
			attributes: attributeKinds(node),
			...(doc === undefined ? {} : { doc }),
			location: { file: span.location.file, line: span.location.line },
		});
	}

	return { functions: [...functions.values()], records, enums, typedefs };
}

const TARGET_PROBES: ReadonlyArray<string> = [
	...C_INTEGER_NAMES.filter(
		(name) => name !== "signed char" && !name.startsWith("unsigned"),
	),
	...C_FLOAT_NAMES,
	"bool",
	"void *",
];

/** Brackets and quotes balance, so a probe of this body cannot swallow later probes. */
function balancedBody(body: string): boolean {
	const stack: Array<string> = [];
	const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
	let quote: string | undefined;
	for (let index = 0; index < body.length; index++) {
		const char = body[index]!;
		if (quote !== undefined) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "(" || char === "[" || char === "{") stack.push(char);
		else if (char in pairs && stack.pop() !== pairs[char]) return false;
	}
	return quote === undefined && stack.length === 0;
}

/** Split clang's filtered JSON dump: pretty-printed top-level objects back to back. */
function filteredDumpNodes(text: string): Array<JsonObject> {
	const nodes: Array<JsonObject> = [];
	let start = -1;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		if (lines[index] === "{") start = index;
		else if (lines[index] === "}" && start >= 0) {
			const parsed: unknown = JSON.parse(lines.slice(start, index + 1).join("\n"));
			if (isObject(parsed)) nodes.push(parsed);
			start = -1;
		}
	}
	return nodes;
}

function unescapeCString(literal: string): string | undefined {
	const match = /^"((?:[^"\\]|\\.)*)"$/.exec(literal);
	if (match === null) return undefined;
	const escapes: Record<string, string> = {
		n: "\n",
		t: "\t",
		r: "\r",
		"0": "\0",
		"\\": "\\",
		'"': '"',
		"'": "'",
	};
	let unsupported = false;
	const value = match[1]!.replace(/\\(.)/g, (_, char: string) => {
		const replacement = escapes[char];
		if (replacement === undefined) unsupported = true;
		return replacement ?? char;
	});
	return unsupported ? undefined : value;
}

/** The value of a literal expression, looking through parentheses and casts. */
function literalValue(expression: JsonObject): number | string | undefined {
	let node = expression;
	let negate = false;
	for (;;) {
		if (node.kind === "ParenExpr" || node.kind === "ImplicitCastExpr") {
			const inner = innerNodes(node)[0];
			if (inner === undefined) return undefined;
			node = inner;
			continue;
		}
		if (node.kind === "UnaryOperator" && node.opcode === "-" && !negate) {
			const inner = innerNodes(node)[0];
			if (inner === undefined) return undefined;
			negate = true;
			node = inner;
			continue;
		}
		break;
	}
	if (node.kind === "FloatingLiteral" && typeof node.value === "string") {
		const value = Number(node.value);
		return negate ? -value : value;
	}
	if (node.kind === "StringLiteral" && typeof node.value === "string" && !negate) {
		return unescapeCString(node.value);
	}
	return undefined;
}

interface MacroProbe {
	readonly macro: PreprocessedMacro;
	readonly type: CType;
	/** The evaluated value; meaningful only when the type is an integer. */
	readonly integer?: bigint;
	readonly literal?: number | string;
}

interface Probes {
	readonly target: CTarget;
	readonly typed: ReadonlyArray<MacroProbe>;
	readonly untyped: ReadonlyArray<PreprocessedMacro>;
}

function probe(
	input: CExtractionInput,
	directory: string,
	includes: string,
	candidates: ReadonlyArray<PreprocessedMacro>,
): Probes {
	const lines = [includes];
	TARGET_PROBES.forEach((name, index) => {
		lines.push(`enum : unsigned long long { __mal_size_${index} = sizeof(${name}) };`);
	});
	lines.push("enum : int { __mal_char_signed = ((char)-1 < 0) };");
	candidates.forEach((macro, index) => {
		lines.push(`typedef __typeof__((${macro.name})) __mal_macro_type_${index};`);
		// Unary plus promotes enums and small integers without changing the value.
		lines.push(
			`enum : __typeof__(+(${macro.name})) { __mal_macro_value_${index} = (${macro.name}) };`,
		);
	});
	const probePath = path.join(directory, "probe-values.c");
	writeFileSync(probePath, `${lines.join("\n")}\n`);
	// Probes of macros that are not expressions fail to compile; each failure stays
	// local to its own declaration, which the AST then marks invalid or omits.
	const result = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		"-w",
		"-ferror-limit=0",
		"-Xclang",
		"-ast-dump=json",
		"-Xclang",
		"-ast-dump-filter=__mal_",
		...input.compileArguments,
		"-x",
		"c",
		probePath,
	]);
	const nodes = new Map<string, JsonObject>();
	for (const node of filteredDumpNodes(result.stdout)) {
		if (typeof node.name === "string") nodes.set(node.name, node);
	}

	const sizes: Record<string, number> = {};
	TARGET_PROBES.forEach((name, index) => {
		const node = nodes.get(`__mal_size_${index}`);
		const value = node === undefined ? undefined : constantValue(node);
		if (value !== undefined) sizes[name] = Number(value);
	});
	for (const name of C_INTEGER_NAMES) {
		const signed = name.replace(/^(?:un)?signed /, "");
		if (sizes[name] === undefined && sizes[signed] !== undefined)
			sizes[name] = sizes[signed]!;
	}
	if (sizes.int === undefined || sizes["void *"] === undefined) {
		throw new FfiError(
			`cannot determine the target data model:\n${result.stderr.trim()}`,
		);
	}
	const charNode = nodes.get("__mal_char_signed");
	const charSigned = charNode !== undefined && constantValue(charNode) === 1n;

	const typed: Array<MacroProbe> = [];
	const untyped: Array<PreprocessedMacro> = [];
	candidates.forEach((macro, index) => {
		const typeNode = nodes.get(`__mal_macro_type_${index}`);
		const typeOf =
			typeNode === undefined || typeNode.isInvalid === true
				? undefined
				: innerNodes(typeNode)[0];
		const expression = typeOf === undefined ? undefined : innerNodes(typeOf)[0];
		if (expression === undefined) {
			untyped.push(macro);
			return;
		}
		const valueNode = nodes.get(`__mal_macro_value_${index}`);
		const integer = valueNode === undefined ? undefined : constantValue(valueNode);
		const literal = literalValue(expression);
		typed.push({
			macro,
			type: nodeType(expression),
			...(integer === undefined ? {} : { integer }),
			...(literal === undefined ? {} : { literal }),
		});
	});
	return { target: { sizes, charSigned }, typed, untyped };
}

/**
 * Extract the declarations a library's headers make available, using the
 * target's own compiler for parsing, constant evaluation, and type sizes.
 * Nothing is executed, so this works for cross targets.
 */
export function extractCModel(input: CExtractionInput): CModel {
	assertClang(input.compiler);
	for (const header of input.headers) {
		if (header.length === 0 || /["\n\\]/.test(header)) {
			throw new FfiError(`invalid header name '${header}'`);
		}
	}
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-"));
	try {
		const cwd = directory;
		const includes = input.headers.map((header) => `#include "${header}"`).join("\n");
		const probePath = path.join(directory, "probe-headers.c");
		writeFileSync(probePath, `${includes}\n`);

		const preprocessed = preprocess(input, probePath, cwd);
		const isLibraryFile = libraryFileFilter(input.headers, preprocessed.headerPaths);

		const dump = runCompiler(input, [
			FFI_C_STANDARD,
			"-fsyntax-only",
			"-w",
			"-Xclang",
			"-ast-dump=json",
			...input.compileArguments,
			"-x",
			"c",
			probePath,
		]);
		if (dump.status !== 0) {
			throw new FfiError(`the library headers do not compile:\n${dump.stderr.trim()}`);
		}
		const ast: unknown = JSON.parse(dump.stdout);
		if (!isObject(ast)) throw new FfiError("clang produced an unexpected AST dump");
		resolveLocations(ast);
		const declarations = collectDeclarations(ast, cwd, isLibraryFile);

		const candidates = [...preprocessed.macros.values()].filter(
			(macro) =>
				!macro.functionLike &&
				macro.body !== "" &&
				!isPseudoFile(macro.file) &&
				isLibraryFile(path.resolve(cwd, macro.file)) &&
				balancedBody(macro.body),
		);
		const probes = probe(input, directory, includes, candidates);

		const base = {
			target: probes.target,
			headers: input.headers.map((spelling, index) => ({
				spelling,
				path: preprocessed.headerPaths[index]!,
			})),
			files: [...preprocessed.files].filter(isLibraryFile).sort(),
			dependencies: [...preprocessed.files].sort(),
			functions: declarations.functions.sort((left, right) =>
				left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
			),
			records: declarations.records,
			enums: declarations.enums,
			typedefs: declarations.typedefs,
		};
		const sources = new SourceTexts();
		const macros: Array<CMacro> = [];
		const untypedMacros: Array<CUntypedMacro> = [];
		const located = (macro: PreprocessedMacro): CLocation => ({
			file: path.resolve(cwd, macro.file),
			line: macro.line,
		});
		for (const macro of probes.untyped) {
			untypedMacros.push({
				name: macro.name,
				body: macro.body,
				location: located(macro),
			});
		}
		for (const entry of probes.typed) {
			const location = located(entry.macro);
			const resolved = resolveCType(
				{ ...base, macros: [], untypedMacros: [] },
				entry.type,
			);
			// A macro that aliases a function or an unsupported type is not a constant.
			if (resolved.kind === "function" || resolved.kind === "unsupported") {
				untypedMacros.push({ name: entry.macro.name, body: entry.macro.body, location });
				continue;
			}
			const integral =
				resolved.kind === "integer" ||
				resolved.kind === "bool" ||
				resolved.kind === "enum";
			const value = integral ? entry.integer : entry.literal;
			const doc = macroComment(sources.lines(location.file), location.line);
			macros.push({
				name: entry.macro.name,
				body: entry.macro.body,
				type: entry.type,
				...(value === undefined ? {} : { value }),
				...(doc === undefined ? {} : { doc }),
				location,
			});
		}
		return { ...base, macros, untypedMacros };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
