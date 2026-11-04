import type { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { artifactDigest } from "../artifact-store.ts";
import type { ToolExecutable } from "../toolchain.ts";
import { clangMajorVersion, toolArguments } from "../toolchain.ts";
import type {
	CEnum,
	CEnumConstant,
	CField,
	CFunction,
	CGlobal,
	CLocation,
	CMacro,
	CModel,
	CParameter,
	CRecord,
	CRecordLayout,
	CTarget,
	CTypedef,
	CUntypedMacro,
} from "./c-model.ts";
import { cRecordAccesses, resolveCType } from "./c-model.ts";
import {
	C_FLOAT_NAMES,
	C_INTEGER_NAMES,
	isCNativeValueType,
	isCScalarType,
	parseCType,
	unnamedTagKey,
} from "./c-type.ts";
import type { CType } from "./c-type.ts";
import { clangProbeDeclarations, visitClangDeclarations } from "./clang-ast.ts";
import { FfiError, FfiSourceChangedError } from "./ffi-error.ts";
import { macroReferences } from "./macros.ts";
import { clangRecordLayouts } from "./record-layout.ts";
import { FfiText, joinText } from "./text.ts";

export interface CExtractionInput {
	/** A clang driver, or `zig cc`, which embeds clang. */
	readonly compiler: ToolExecutable;
	readonly environment: NodeJS.ProcessEnv;
	/** Header spellings as C code includes them, such as `raylib.h` or `curl/curl.h`. */
	readonly headers: ReadonlyArray<string>;
	/** Include directories and defines the library needs, as compiler arguments. */
	readonly compileArguments: ReadonlyArray<string>;
	readonly macroRoots?: ReadonlyArray<string>;
	readonly onDependencies?: (files: ReadonlyArray<string>) => void;
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
): { status: number | null; stdout: Buffer; stderr: string } {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-output-"));
	const stdout = path.join(directory, "stdout");
	const stderr = path.join(directory, "stderr");
	const descriptors: Array<number> = [];
	try {
		descriptors.push(openSync(stdout, "w"));
		descriptors.push(openSync(stderr, "w"));
		const result = spawnSync(
			input.compiler.path,
			toolArguments(input.compiler, [...args]),
			{
				env: input.environment,
				stdio: ["ignore", descriptors[0]!, descriptors[1]!],
			},
		);
		if (result.error !== undefined)
			throw new FfiError(`cannot run ${input.compiler.path}: ${result.error.message}`);
		return {
			status: result.status,
			stdout: readFileSync(stdout),
			stderr: readFileSync(stderr, "utf8"),
		};
	} finally {
		for (const descriptor of descriptors) closeSync(descriptor);
		rmSync(directory, { recursive: true, force: true });
	}
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

const skipBodiesSupport = new Map<string, boolean>();

function skipFunctionBodies(input: CExtractionInput): ReadonlyArray<string> {
	const key = JSON.stringify([
		input.compiler.path,
		input.compiler.args,
		input.compiler.version,
	]);
	let supported = skipBodiesSupport.get(key);
	if (supported === undefined) {
		const help = runCompiler(input, [
			"-Xclang",
			"-help",
			"-fsyntax-only",
			"-x",
			"c",
			"-",
		]);
		supported =
			help.status === 0 &&
			/(?:^|\n)\s+-skip-function-bodies(?:\s|$)/.test(
				help.stdout.toString("utf8") + help.stderr,
			);
		skipBodiesSupport.set(key, supported);
	}
	return supported ? ["-Xclang", "-skip-function-bodies"] : [];
}

interface PreprocessedMacro {
	readonly name: string;
	readonly body: string;
	readonly parameters?: ReadonlyArray<string>;
	readonly variadic?: boolean;
	readonly file: string;
	readonly line: number;
}

interface Preprocessed {
	readonly identity: string;
	readonly headerPaths: ReadonlyArray<string>;
	readonly files: ReadonlySet<string>;
	readonly macros: ReadonlyMap<string, PreprocessedMacro>;
}

const LINE_MARKER = /^# (\d+) "((?:[^"\\]|\\.)*)"((?: \d+)*)$/;
const DEFINE = /^#define ([A-Za-z_]\w*)(\()?/;

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
	const stack: Array<string> = [];
	const directIncludes: Array<string> = [];
	const files = new Set<string>();
	const macros = new Map<string, PreprocessedMacro>();
	let file = "";
	let line = 0;
	const identity = createHash("sha256");
	for (let start = 0; start < result.stdout.length;) {
		const lineStart = start;
		let end = result.stdout.indexOf(10, start);
		if (end < 0) end = result.stdout.length;
		const directive = result.stdout[start] === 35;
		const text = directive ? result.stdout.toString("utf8", start, end) : "";
		start = end + 1;
		const marker = LINE_MARKER.exec(text);
		if (marker !== null && unescapeMarkerPath(marker[2]!) === probePath)
			identity.update(`# ${marker[1]} "<maligator-header-probe>"${marker[3]}\n`);
		else
			identity.update(
				result.stdout.subarray(lineStart, Math.min(end + 1, result.stdout.length)),
			);
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
			if (flags.includes("1") && !isPseudoFile(name)) files.add(path.resolve(cwd, name));
			file = name;
			line = Number(marker[1]);
			continue;
		}
		const define = DEFINE.exec(text);
		if (define !== null) {
			let body = text.slice(define[0].length).trim();
			let parameters: Array<string> | undefined;
			let variadic = false;
			if (define[2] !== undefined) {
				const end = body.indexOf(")");
				parameters = body
					.slice(0, end)
					.split(",")
					.map((parameter) => parameter.trim())
					.filter(Boolean)
					.map((parameter) => {
						if (!parameter.endsWith("...")) return parameter;
						variadic = true;
						return parameter.slice(0, -3).trim() || "__VA_ARGS__";
					});
				body = body.slice(end + 1).trim();
			}
			macros.set(define[1]!, {
				name: define[1]!,
				body,
				...(parameters === undefined ? {} : { parameters }),
				...(variadic ? { variadic: true } : {}),
				file,
				line,
			});
		} else if (text.startsWith("#undef ")) {
			macros.delete(text.slice("#undef ".length).trim());
		}
		line++;
	}
	files.delete(probePath);
	input.onDependencies?.([...files].sort());
	if (result.status !== 0) {
		throw new FfiError(`cannot preprocess the library headers:\n${result.stderr.trim()}`);
	}
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
	return {
		identity: identity.digest("hex"),
		headerPaths,
		files,
		macros,
	};
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
function createLocationResolver(): (root: unknown) => void {
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
	return visit;
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
	if (node.isInvalid === true) return { kind: "unsupported", spelling };
	if (
		node.kind === "ComplexType" ||
		node.kind === "VectorType" ||
		node.kind === "ExtVectorType"
	) {
		if (node.kind === "VectorType" && !spelling.includes("vector_size"))
			return { kind: "unsupported", spelling };
		const child = innerNodes(node).find(
			(child) =>
				typeof child.kind === "string" &&
				(child.kind.endsWith("Type") || child.kind === "QualType"),
		);
		const of = child === undefined ? undefined : nodeType(child);
		if (of === undefined || !isCScalarType(of)) return { kind: "unsupported", spelling };
		if (node.kind === "ComplexType") return { kind: "complex", of };
		const length = node.numElements;
		return typeof length === "number" && Number.isSafeInteger(length) && length > 0
			? {
					kind: "vector",
					of,
					length,
					flavor: node.kind === "ExtVectorType" ? "ext" : "gnu",
				}
			: { kind: "unsupported", spelling };
	}
	const parsed = parseCType(spelling);
	if (node.kind === "TypedefDecl") {
		const representation = innerNodes(node).find(
			(child) => child.kind === "VectorType" || child.kind === "ExtVectorType",
		);
		if (representation !== undefined) return nodeType(representation);
	}
	if (parsed.kind !== "unsupported") return parsed;
	const desugared =
		type === undefined ? undefined : stringField(type, "desugaredQualType");
	const canonical = desugared === undefined ? parsed : parseCType(desugared);
	if (canonical.kind !== "unsupported") return canonical;
	const children = innerNodes(node).filter(
		(child) =>
			typeof child.kind === "string" &&
			(child.kind.endsWith("Type") || child.kind === "QualType"),
	);
	const child = children.at(-1);
	if (child === undefined) return canonical;
	switch (node.kind) {
		case "TypedefDecl":
		case "TypeOfExprType":
		case "MacroQualifiedType":
		case "ParenType":
			return nodeType(child);
		case "PointerType": {
			const target = nodeType(child);
			return target.kind === "unsupported" ? canonical : { kind: "pointer", to: target };
		}
		case "FunctionProtoType": {
			const types = children.map(nodeType);
			if (types.some((type) => type.kind === "unsupported")) return canonical;
			return {
				kind: "function",
				returns: types[0]!,
				params: types.slice(1),
				variadic: node.variadic === true,
			};
		}
		case "QualType": {
			const qualifiers = stringField(node, "qualifiers")?.split(" ") ?? [];
			if (
				qualifiers.some(
					(qualifier) => !["const", "volatile", "restrict"].includes(qualifier),
				)
			)
				return canonical;
			const target = nodeType(child);
			if (
				target.kind === "unsupported" ||
				target.kind === "array" ||
				target.kind === "function"
			)
				return canonical;
			return qualifiers.includes("const") ? { ...target, const: true } : target;
		}
		default:
			return canonical;
	}
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
	readonly #files = new Map<string, ReadonlyArray<FfiText>>();

	lines(file: string): ReadonlyArray<FfiText> {
		let lines = this.#files.get(file);
		if (lines === undefined) {
			let data: Buffer | undefined;
			try {
				data = readFileSync(file);
			} catch {
				data = undefined;
			}
			const decoded: Array<FfiText> = [];
			if (data !== undefined) {
				for (let start = 0; start <= data.length;) {
					let end = data.indexOf(10, start);
					if (end < 0) end = data.length;
					decoded.push(FfiText.fromUtf8(data, start, end));
					start = end + 1;
				}
			}
			lines = decoded;
			this.#files.set(file, lines);
		}
		return lines;
	}
}

/** Remove comment markers and decorative rules, keeping the prose lines. */
function cleanComment(raw: ReadonlyArray<FfiText>): FfiText | undefined {
	const stars = (text: FfiText, end = false): number => {
		let count = 0;
		for (const chunk of end ? [...text.chunks].reverse() : text.chunks) {
			const length = (end ? /\*+$/ : /^\*+/).exec(chunk)?.[0].length ?? 0;
			count += length;
			if (length !== chunk.length) break;
		}
		return count;
	};
	const lines = raw
		.map((rawLine) => {
			let line = rawLine.trim();
			if (line.startsWith("/*")) {
				line = line.slice(1);
				line = line.slice(stars(line));
				if (line.startsWith("!")) line = line.slice(1);
			}
			if (line.endsWith("*/")) {
				line = line.slice(0, -1);
				line = line.slice(0, line.length - stars(line, true));
			}
			if (line.startsWith("//")) {
				line = line.slice(2);
				if (["/", "!", "<"].some((marker) => line.startsWith(marker)))
					line = line.slice(1);
			}
			line = line.slice(stars(line)).trim();
			return line;
		})
		.filter(
			(line) =>
				!(line.length >= 3 && line.chunks.every((chunk) => /^[-=*#/~_+]*$/.test(chunk))),
		);
	while (lines[0]?.length === 0) lines.shift();
	while (lines.at(-1)?.length === 0) lines.pop();
	return lines.length === 0 ? undefined : joinText(lines, "\n");
}

/** A comment that follows only closing punctuation after `column` on `line`. */
function trailingComment(
	lines: ReadonlyArray<FfiText>,
	line: number,
	column: number,
): FfiText | undefined {
	const text = lines[line - 1];
	if (text === undefined) return undefined;
	const rest = text.slice(Math.max(0, column - 1));
	let skip = 0;
	for (const chunk of rest.chunks) {
		const length = /^[\s;,)]*/.exec(chunk)![0].length;
		skip += length;
		if (length !== chunk.length) break;
	}
	const comment = rest.slice(skip);
	if (!comment.startsWith("//") && !comment.startsWith("/*")) return undefined;
	if (comment.startsWith("//")) return cleanComment([comment]);
	const block = [comment];
	for (let index = line; !block.at(-1)!.includes("*/") && index < lines.length; index++) {
		block.push(lines[index]!);
	}
	return cleanComment(block);
}

/** The comment after a `#define` on `line`, skipping string and character literals. */
function macroComment(lines: ReadonlyArray<FfiText>, line: number): FfiText | undefined {
	const text = lines[line - 1];
	if (text === undefined) return undefined;
	let quote: string | undefined;
	let escaped = false;
	let slash = false;
	let offset = 0;
	for (const chunk of text.chunks) {
		for (let index = 0; index < chunk.length; index++) {
			const char = chunk[index]!;
			if (quote !== undefined) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (slash && (char === "/" || char === "*"))
				return trailingComment(lines, line, offset + index);
			if (char === '"' || char === "'") quote = char;
			slash = char === "/";
		}
		offset += chunk.length;
	}
	return undefined;
}

/** The comment block whose last line sits directly above `line`. */
function commentBlockAbove(
	lines: ReadonlyArray<FfiText>,
	line: number,
): { text: FfiText | undefined } | undefined {
	const above = lines[line - 2]?.trim();
	if (above === undefined) return undefined;
	if (above.startsWith("//")) {
		const block: Array<FfiText> = [];
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
		const block: Array<FfiText> = [];
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

interface DocumentedFile {
	readonly ends: Map<number, DocumentedSpan>;
	readonly starts: Set<number>;
	preceding?: Map<number, FfiText | undefined>;
}

/**
 * Documentation for a declaration: a trailing comment on its last line, otherwise
 * the comment block above it. Undocumented sibling declarations between the two
 * share that block, which is how SQLite documents a group of functions.
 */
class Documentation {
	readonly #sources = new SourceTexts();
	readonly #files = new Map<string, DocumentedFile>();

	trailing(location: NodeLocation): FfiText | undefined {
		return trailingComment(
			this.#sources.lines(location.file),
			location.line,
			location.end,
		);
	}

	record(file: string, span: DocumentedSpan): void {
		let documented = this.#files.get(file);
		if (documented === undefined) {
			documented = { ends: new Map(), starts: new Set() };
			this.#files.set(file, documented);
		}
		documented.starts.add(span.begin);
		if (!span.trailing && !documented.ends.has(span.end))
			documented.ends.set(span.end, span);
	}

	declaration(span: DeclarationSpan): FfiText | undefined {
		const trailing = this.trailing(span.end);
		if (trailing !== undefined) return trailing;
		const lines = this.#sources.lines(span.begin.file);
		const file = this.#files.get(span.begin.file);
		if (file?.preceding === undefined && file !== undefined) {
			const preceding = new Map<number, FfiText | undefined>();
			// Spans are complete before lookup; every adjacent predecessor starts earlier.
			for (const line of [...file.starts].sort((left, right) => left - right)) {
				const block = commentBlockAbove(lines, line);
				const sibling = file.ends.get(line - 1);
				preceding.set(
					line,
					block !== undefined
						? block.text
						: sibling === undefined
							? undefined
							: preceding.get(sibling.begin),
				);
			}
			file.preceding = preceding;
		}
		if (file?.preceding?.has(span.begin.line)) return file.preceding.get(span.begin.line);
		const block = commentBlockAbove(lines, span.begin.line);
		if (block !== undefined) return block.text;
		const sibling = file?.ends.get(span.begin.line - 1);
		return sibling === undefined ? undefined : file?.preceding?.get(sibling.begin);
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
	readonly globals: Array<CGlobal>;
	readonly records: Map<string, CRecord>;
	readonly enums: Map<string, CEnum>;
	readonly typedefs: Map<string, CTypedef>;
}

function collectDeclarations(
	topLevel: ReadonlyArray<JsonObject>,
	cwd: string,
	isLibraryFile: (file: string) => boolean,
	layouts: ReadonlyMap<string, CRecordLayout | null>,
): Declarations {
	const documentation = new Documentation();

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
	const globals = new Map<string, CGlobal>();
	const globalLinkage = new Map<string, CGlobal["linkage"]>();

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
			if (child.kind === "EnumDecl") {
				const childKey = recordKey(child);
				if (childKey !== undefined) registerEnum(child, childKey);
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
		const tag = node.tagUsed === "union" ? "union" : "struct";
		const layout = layouts.get(`${tag} ${key}`);
		records.set(key, {
			name: key,
			tag,
			complete,
			fields,
			...(complete &&
			layout !== null &&
			layout !== undefined &&
			layout.fieldOffsetsBits.length === fields.length
				? { layout }
				: {}),
			attributes: attributeKinds(node),
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
				attributes: attributeKinds(node),
				...(doc === undefined ? {} : { doc }),
				location: { file: span.location.file, line: span.location.line },
				library,
			});
			continue;
		}
		if (node.kind === "VarDecl" && typeof node.name === "string") {
			// An extern redeclaration keeps linkage established by an earlier static declaration.
			const linkage =
				globalLinkage.get(node.name) === "internal" ||
				node.storageClass === "static" ||
				node.constexpr === true
					? "internal"
					: "external";
			globalLinkage.set(node.name, linkage);
			const span = spanOf(node, cwd);
			if (span === undefined || !isLibraryFile(span.location.file)) continue;
			const doc = documentation.declaration(span);
			globals.set(node.name, {
				name: node.name,
				type: nodeType(node),
				linkage,
				threadLocal: typeof node.tls === "string",
				attributes: attributeKinds(node),
				...(doc === undefined ? {} : { doc }),
				location: { file: span.location.file, line: span.location.line },
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

	return {
		functions: [...functions.values()],
		globals: [...globals.values()],
		records,
		enums,
		typedefs,
	};
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
	readonly expansions: ReadonlyMap<
		string,
		{ readonly expansion?: string; readonly contextual: boolean }
	>;
}

interface ValueProbe {
	readonly path: string;
	readonly preprocessed: boolean;
	readonly identity: string;
}

function prepareValueProbe(
	input: CExtractionInput,
	directory: string,
	includes: string,
	candidates: ReadonlyArray<PreprocessedMacro>,
): ValueProbe {
	const lines = [includes];
	lines.push(
		"#define __mal_stringify(...) #__VA_ARGS__",
		"#define __mal_expand(...) __mal_stringify(__VA_ARGS__)",
	);
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
		lines.push(
			`static const char __mal_expansion_normal_${index}[] = __mal_expand(${macro.name});`,
		);
	});
	// Compare actual expansion with a different caller context, after probing the
	// ordinary declarations. Stringifying through Clang also follows token pasting.
	for (const [name, value] of Object.entries({
		__FILE__: '"<maligator-context-file>"',
		__BASE_FILE__: '"<maligator-context-base>"',
		__FILE_NAME__: '"<maligator-context-name>"',
		__LINE__: "2147483646",
		__INCLUDE_LEVEL__: "2147483645",
		__COUNTER__: "2147483644",
		__TIME__: '"<maligator-context-time>"',
		__DATE__: '"<maligator-context-date>"',
		__TIMESTAMP__: '"<maligator-context-timestamp>"',
	}))
		lines.push(`#undef ${name}`, `#define ${name} ${value}`);
	candidates.forEach((macro, index) => {
		lines.push(
			`static const char __mal_expansion_neutral_${index}[] = __mal_expand(${macro.name});`,
		);
	});
	const probePath = path.join(directory, "probe-values.c");
	writeFileSync(probePath, `${lines.join("\n")}\n`);
	const expanded = runCompiler(input, [
		FFI_C_STANDARD,
		"-E",
		"-w",
		...input.compileArguments,
		"-x",
		"c",
		probePath,
	]);
	const identity = createHash("sha256");
	for (let start = 0; start < expanded.stdout.length;) {
		let end = expanded.stdout.indexOf(10, start);
		if (end < 0) end = expanded.stdout.length;
		const line =
			expanded.stdout[start] === 35 ? expanded.stdout.toString("utf8", start, end) : "";
		const marker = LINE_MARKER.exec(line);
		if (marker !== null && unescapeMarkerPath(marker[2]!) === probePath)
			identity.update(`# ${marker[1]} "<maligator-value-probe>"${marker[3]}\n`);
		else
			identity.update(
				expanded.stdout.subarray(start, Math.min(end + 1, expanded.stdout.length)),
			);
		start = end + 1;
	}
	if (expanded.status !== 0)
		return { path: probePath, preprocessed: false, identity: identity.digest("hex") };
	const artifact = path.join(directory, "probe-values.i");
	writeFileSync(artifact, expanded.stdout);
	return { path: artifact, preprocessed: true, identity: identity.digest("hex") };
}

function probe(
	input: CExtractionInput,
	valueProbe: ValueProbe,
	candidates: ReadonlyArray<PreprocessedMacro>,
): Probes {
	// Probes of macros that are not expressions fail to compile; each failure stays
	// local to its own declaration, which the AST then marks invalid or omits.
	const result = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		"-ferror-limit=0",
		"-Xclang",
		"-ast-dump=json",
		"-Xclang",
		"-ast-dump-filter=__mal_",
		...input.compileArguments,
		"-w",
		"-x",
		valueProbe.preprocessed ? "cpp-output" : "c",
		valueProbe.path,
	]);
	const nodes = new Map<string, JsonObject>();
	for (const node of clangProbeDeclarations(result.stdout)) {
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
	const expansions = new Map<
		string,
		{ readonly expansion?: string; readonly contextual: boolean }
	>();
	const stringToken = (node: JsonObject | undefined): string | undefined => {
		if (node === undefined || node.isInvalid === true) return undefined;
		if (node.kind === "StringLiteral" && typeof node.value === "string")
			return node.value;
		for (const child of innerNodes(node)) {
			const value = stringToken(child);
			if (value !== undefined) return value;
		}
		return undefined;
	};
	candidates.forEach((macro, index) => {
		const normal = stringToken(nodes.get(`__mal_expansion_normal_${index}`));
		const neutral = stringToken(nodes.get(`__mal_expansion_neutral_${index}`));
		// Compiler source-location builtins survive preprocessing but change when
		// their expression is emitted in the binding's function body.
		const sourceLocation =
			neutral !== undefined &&
			macroReferences(unescapeCString(neutral) ?? neutral.slice(1, -1)).some((name) =>
				/^__builtin_(?:LINE|COLUMN|FILE|FUNCTION|FUNCSIG|source_location)$/.test(name),
			);
		expansions.set(macro.name, {
			...(neutral === undefined ? {} : { expansion: neutral }),
			contextual:
				normal === undefined ||
				neutral === undefined ||
				normal !== neutral ||
				sourceLocation,
		});
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
	return { target: { sizes, charSigned }, typed, untyped, expansions };
}

/**
 * Extract the declarations a library's headers make available, using the
 * target's own compiler for parsing, constant evaluation, and type sizes.
 * Nothing is executed, so this works for cross targets.
 */
export function extractCModel(input: CExtractionInput): CModel {
	return withCHeaders(input, (headers) => extractCModelFromHeaders(input, headers));
}

/** Implementation headers also invalidate a linked runtime when its public ABI is unchanged. */
export function extractCSourceDependencies(
	input: Omit<CExtractionInput, "headers">,
	source: string,
): ReadonlyArray<string> {
	assertClang(input.compiler);
	input.onDependencies?.([path.dirname(source)]);
	const extracted = preprocess({ ...input, headers: [] }, source, process.cwd());
	return [...new Set([source, ...extracted.files])].sort();
}

interface CHeaderVersion {
	readonly file: string;
	readonly digest: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly ino: number;
	readonly dev: number;
}

export interface CHeaders {
	readonly directory: string;
	readonly probePath: string;
	readonly preprocessed: Preprocessed;
	readonly versions: ReadonlyArray<CHeaderVersion>;
	readonly cacheable: boolean;
	readonly candidates: ReadonlyArray<PreprocessedMacro>;
	readonly definitions: ReadonlyArray<PreprocessedMacro>;
	readonly valueProbe: ValueProbe;
	validate(): void;
}

function headerVersion(file: string): CHeaderVersion {
	try {
		const before = statSync(file);
		const digest = artifactDigest(new Uint8Array(readFileSync(file)));
		const after = statSync(file);
		if (
			["size", "mtimeMs", "ctimeMs", "ino", "dev"].some(
				(key) => Reflect.get(before, key) !== Reflect.get(after, key),
			)
		)
			throw new FfiSourceChangedError([file]);
		return {
			file,
			digest,
			size: before.size,
			mtimeMs: before.mtimeMs,
			ctimeMs: before.ctimeMs,
			ino: before.ino,
			dev: before.dev,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new FfiSourceChangedError([file]);
		throw error;
	}
}

export function headerSearchDirectories(input: CExtractionInput): Array<string> {
	const directories: Array<string> = [];
	const flags = ["-isystem", "-iquote", "-idirafter", "-iframework", "-I", "-F"];
	const args = [...(input.compiler.args ?? []), ...input.compileArguments];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		const flag = flags.find((candidate) => argument.startsWith(candidate));
		if (flag === undefined) continue;
		const directory = argument === flag ? args[++index] : argument.slice(flag.length);
		if (directory !== undefined && directory.length > 0)
			directories.push(path.resolve(directory));
	}
	for (const name of ["CPATH", "C_INCLUDE_PATH"]) {
		const value = input.environment[name];
		if (value !== undefined)
			for (const directory of value.split(path.delimiter))
				directories.push(path.resolve(directory));
	}
	return [
		...new Set([
			...directories,
			...input.headers.filter(path.isAbsolute).map((header) => path.dirname(header)),
		]),
	];
}

function directoryVersion(directory: string): string | undefined {
	try {
		const value = statSync(directory);
		return [value.size, value.mtimeMs, value.ctimeMs, value.ino, value.dev].join(":");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function snapshotDirectoryTree(
	directory: string,
	versions: Map<string, string | undefined>,
	visited: Set<string>,
	scratch: string,
): boolean {
	// A broad shared search tree can cost more to guard than parsing its selected headers.
	if (visited.size >= 2048) return false;
	try {
		const before = directoryVersion(directory);
		if (versions.has(directory) && versions.get(directory) !== before)
			throw new FfiSourceChangedError([directory]);
		versions.set(directory, before);
		if (before === undefined) {
			const parent = path.dirname(directory);
			if (!versions.has(parent)) versions.set(parent, directoryVersion(parent));
			return true;
		}
		const real = realpathSync(directory);
		if (real === scratch) {
			versions.delete(directory);
			return true;
		}
		if (visited.has(real) || !statSync(directory).isDirectory()) return true;
		visited.add(real);
		for (const entry of readdirSync(directory, { withFileTypes: true }))
			if (
				(entry.isDirectory() || entry.isSymbolicLink()) &&
				!snapshotDirectoryTree(
					path.join(directory, entry.name),
					versions,
					visited,
					scratch,
				)
			)
				return false;
		if (directoryVersion(directory) !== before)
			throw new FfiSourceChangedError([directory]);
		return true;
	} catch (error) {
		if (
			["EACCES", "EPERM", "ELOOP", "ENOENT", "ENOTDIR"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			return false;
		throw error;
	}
}

/** Clang resolves includes before cache lookup, including absent and shadowed headers. */
export function withCHeaders<Result>(
	input: CExtractionInput,
	read: (headers: CHeaders) => Result,
): Result {
	assertClang(input.compiler);
	const searchDirectories = headerSearchDirectories(input);
	input.onDependencies?.(searchDirectories);
	for (const header of input.headers) {
		if (header.length === 0 || /["\n\\]/.test(header)) {
			throw new FfiError(`invalid header name '${header}'`);
		}
	}
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-"));
	try {
		const directories = new Map<string, string | undefined>();
		const visited = new Set<string>();
		const scratch = realpathSync(directory);
		const guarded = searchDirectories.every((root) =>
			snapshotDirectoryTree(root, directories, visited, scratch),
		);
		const includes = input.headers.map((header) => `#include "${header}"`).join("\n");
		const probePath = path.join(directory, "probe-headers.c");
		writeFileSync(probePath, `${includes}\n`);

		const preprocessed = preprocess(input, probePath, directory);
		const versions = [...preprocessed.files].sort().map(headerVersion);
		for (const file of preprocessed.files) {
			const parent = path.dirname(file);
			if (!directories.has(parent)) directories.set(parent, directoryVersion(parent));
		}
		const isLibraryFile = libraryFileFilter(input.headers, preprocessed.headerPaths);
		const exported = [...preprocessed.macros.values()].filter(
			(macro) =>
				macro.parameters === undefined &&
				macro.body !== "" &&
				!isPseudoFile(macro.file) &&
				isLibraryFile(path.resolve(directory, macro.file)) &&
				balancedBody(macro.body),
		);
		const selected = new Set<string>();
		const pending = [...exported.map((macro) => macro.name), ...(input.macroRoots ?? [])];
		while (pending.length > 0) {
			const name = pending.pop()!;
			if (selected.has(name)) continue;
			const macro = preprocessed.macros.get(name);
			if (macro === undefined) continue;
			selected.add(name);
			pending.push(...macroReferences(macro.body, macro.parameters));
		}
		const definitions = [...preprocessed.macros.values()].filter((macro) =>
			selected.has(macro.name),
		);
		const candidates = definitions.filter(
			(macro) =>
				macro.parameters === undefined && macro.body !== "" && balancedBody(macro.body),
		);
		const valueProbe = prepareValueProbe(input, directory, includes, candidates);
		let includeGraphValidated = false;
		const headers: CHeaders = {
			directory,
			probePath,
			preprocessed,
			versions,
			cacheable: valueProbe.preprocessed && guarded,
			candidates,
			definitions,
			valueProbe,
			validate() {
				if (!includeGraphValidated) {
					let current: Preprocessed;
					try {
						current = preprocess(input, probePath, directory);
					} catch (error) {
						if (error instanceof FfiError)
							throw new FfiSourceChangedError([...preprocessed.files]);
						throw error;
					}
					if (
						JSON.stringify([...current.files].sort()) !==
							JSON.stringify([...preprocessed.files].sort()) ||
						JSON.stringify(current.headerPaths) !==
							JSON.stringify(preprocessed.headerPaths)
					)
						throw new FfiSourceChangedError([
							...new Set([...preprocessed.files, ...current.files]),
						]);
					includeGraphValidated = true;
				}
				const changed = versions
					.filter(
						(before) =>
							JSON.stringify(headerVersion(before.file)) !== JSON.stringify(before),
					)
					.map((version) => version.file);
				if (guarded)
					for (const [root, before] of directories)
						if (directoryVersion(root) !== before) changed.push(root);
				if (changed.length > 0) throw new FfiSourceChangedError(changed);
			},
		};
		const result = read(headers);
		headers.validate();
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Macro-qualified spellings need type trees; typeof preserves their original header identities. */
function probeDeclarationTypes(
	input: CExtractionInput,
	headers: CHeaders,
	declarations: Declarations,
): Declarations {
	const functions = [...declarations.functions];
	const globals = [...declarations.globals];
	const records = new Map(declarations.records);
	const queries: Array<{ expression: string; apply(type: CType): void }> = [];
	globals.forEach((global, index) => {
		if (global.type.kind !== "unsupported") return;
		queries.push({
			expression: global.name,
			apply(type) {
				if (type.kind !== "unsupported") globals[index] = { ...global, type };
			},
		});
	});
	functions.forEach((fn, index) => {
		if (
			fn.returns.kind !== "unsupported" &&
			!fn.params.some((param) => param.type.kind === "unsupported")
		)
			return;
		queries.push({
			expression: fn.name,
			apply(type) {
				if (type.kind !== "function") return;
				functions[index] = {
					...fn,
					returns: type.returns,
					params: fn.params.map((param, position) => ({
						...param,
						type: type.params[position] ?? param.type,
					})),
					variadic: type.variadic,
				};
			},
		});
	});
	const accesses = cRecordAccesses(declarations);
	for (const record of declarations.records.values()) {
		const access = accesses.get(record.name);
		if (access === undefined) continue;
		record.fields.forEach((field, index) => {
			if (
				field.name === undefined ||
				field.bitWidth !== undefined ||
				field.type.kind !== "unsupported"
			)
				return;
			queries.push({
				expression: `(${access.expression}).${field.name}`,
				apply(type) {
					if (type.kind === "unsupported") return;
					const current = records.get(record.name)!;
					records.set(record.name, {
						...current,
						fields: current.fields.map((field, position) =>
							position === index ? { ...field, type } : field,
						),
					});
				},
			});
		});
	}
	if (queries.length === 0) return declarations;
	const source = path.join(headers.directory, "probe-declaration-types.c");
	writeFileSync(
		source,
		[
			...input.headers.map((header) => `#include "${header}"`),
			...queries.map(
				(query, index) =>
					`typedef __typeof__(${query.expression}) __mal_declaration_type_${index};`,
			),
		].join("\n"),
	);
	const dump = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		"-ferror-limit=0",
		"-Xclang",
		"-ast-dump=json",
		"-Xclang",
		"-ast-dump-filter=__mal_declaration_type_",
		...input.compileArguments,
		"-w",
		"-x",
		"c",
		source,
	]);
	for (const node of clangProbeDeclarations(dump.stdout)) {
		const name = stringField(node, "name");
		if (name === undefined || !name.startsWith("__mal_declaration_type_")) continue;
		queries[Number(name.slice("__mal_declaration_type_".length))]?.apply(nodeType(node));
	}
	return { ...declarations, functions, globals, records };
}

/** Clang's JSON leaves storage layout and compatible enum types to target probes. */
function probeTypeMetadata(
	input: CExtractionInput,
	headers: CHeaders,
	declarations: ReturnType<typeof collectDeclarations>,
	target: CTarget,
): Pick<CModel, "records" | "enums" | "typedefs"> {
	const names = C_INTEGER_NAMES.filter((name) => target.sizes[name] !== undefined);
	const queries: Array<{
		expression: string;
		record?: string;
		field?: number;
		enumeration?: string;
		alignment?: string;
		size?: string;
	}> = [];
	const accesses = cRecordAccesses(declarations);
	for (const record of declarations.records.values()) {
		const access = accesses.get(record.name);
		if (access === undefined) continue;
		record.fields.forEach((field, index) => {
			if (
				field.name !== undefined &&
				(field.bitWidth !== undefined || field.type.kind === "enum")
			)
				queries.push({
					expression: `(${access.expression}).${field.name}`,
					record: record.name,
					field: index,
				});
		});
	}
	for (const enumeration of declarations.enums.values()) {
		if (
			!/^[A-Za-z_]\w*$/.test(enumeration.name) ||
			(!enumeration.named && !declarations.typedefs.has(enumeration.name))
		)
			continue;
		queries.push({
			expression: `(${enumeration.named ? `enum ${enumeration.name}` : enumeration.name})0`,
			enumeration: enumeration.name,
		});
	}
	for (const alias of declarations.typedefs.values()) {
		const native = isCNativeValueType(resolveCType(declarations, alias.type));
		if (alias.attributes?.includes("Aligned") !== true && !native) continue;
		queries.push({
			expression: `_Alignof(${alias.name}) * __CHAR_BIT__`,
			alignment: alias.name,
		});
		if (native)
			queries.push({
				expression: `sizeof(${alias.name}) * __CHAR_BIT__`,
				size: alias.name,
			});
	}
	if (queries.length === 0) return declarations;
	const source = path.join(headers.directory, "probe-integer-types.c");
	writeFileSync(
		source,
		[
			...input.headers.map((header) => `#include "${header}"`),
			...queries.map((query, index) =>
				query.alignment === undefined && query.size === undefined
					? `enum : int { __mal_integer_type_${index} = _Generic((${query.expression}), ${names.map((name, type) => `${name}: ${type}`).join(", ")}, default: -1) };`
					: `enum : unsigned long long { __mal_integer_type_${index} = ${query.expression} };`,
			),
		].join("\n"),
	);
	const dump = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		"-ferror-limit=0",
		"-Xclang",
		"-ast-dump=json",
		"-Xclang",
		"-ast-dump-filter=__mal_integer_type_",
		...input.compileArguments,
		"-w",
		"-x",
		"c",
		source,
	]);
	const values = new Map<string, bigint>();
	for (const node of clangProbeDeclarations(dump.stdout)) {
		const value = constantValue(node);
		if (typeof node.name === "string" && value !== undefined)
			values.set(node.name, value);
	}
	const records = new Map(declarations.records),
		enums = new Map(declarations.enums),
		typedefs = new Map(declarations.typedefs);
	queries.forEach((query, index) => {
		const value = values.get(`__mal_integer_type_${index}`);
		if (query.size !== undefined) {
			if (value !== undefined && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
				typedefs.set(query.size, {
					...typedefs.get(query.size)!,
					sizeBits: Number(value),
				});
			return;
		}
		if (query.alignment !== undefined) {
			if (value !== undefined && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
				typedefs.set(query.alignment, {
					...typedefs.get(query.alignment)!,
					alignmentBits: Number(value),
				});
			return;
		}
		const name = value === undefined ? undefined : names[Number(value)];
		if (name === undefined) return;
		if (query.enumeration !== undefined)
			enums.set(query.enumeration, {
				...enums.get(query.enumeration)!,
				underlying: { kind: "integer", name },
			});
		else if (query.record !== undefined && query.field !== undefined) {
			const record = records.get(query.record)!;
			records.set(query.record, {
				...record,
				fields: record.fields.map((field, fieldIndex) =>
					fieldIndex === query.field
						? {
								...field,
								integerType: { kind: "integer" as const, name },
							}
						: field,
				),
			});
		}
	});
	return { records, enums, typedefs };
}

export function extractCModelFromHeaders(
	input: CExtractionInput,
	headers: CHeaders,
): CModel {
	const { directory, probePath, preprocessed } = headers;
	const cwd = directory;
	const isLibraryFile = libraryFileFilter(input.headers, preprocessed.headerPaths);

	const dump = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		"-Xclang",
		"-ast-dump=json",
		...input.compileArguments,
		"-w",
		"-x",
		"c",
		probePath,
	]);
	if (dump.status !== 0) {
		throw new FfiError(`the library headers do not compile:\n${dump.stderr.trim()}`);
	}
	const layoutDump = runCompiler(input, [
		FFI_C_STANDARD,
		"-fsyntax-only",
		...skipFunctionBodies(input),
		"-Xclang",
		"-fdump-record-layouts-complete",
		"-Xclang",
		"-fdump-record-layouts-simple",
		...input.compileArguments,
		"-w",
		"-x",
		"c",
		probePath,
	]);
	if (layoutDump.status !== 0)
		throw new FfiError(`cannot extract C record layouts:\n${layoutDump.stderr.trim()}`);
	const layouts = clangRecordLayouts(layoutDump.stdout.toString("utf8"));
	const nodes: Array<JsonObject> = [];
	// Clang compresses locations across declarations, including function bodies we drop.
	const resolveLocations = createLocationResolver();
	visitClangDeclarations(dump.stdout, (node) => {
		resolveLocations(node);
		if (node.kind === "FunctionDecl") {
			node.inner = innerNodes(node).filter(
				(child) =>
					child.kind === "ParmVarDecl" ||
					(typeof child.kind === "string" && child.kind.endsWith("Attr")),
			);
		}
		if (node.isImplicit !== true) nodes.push(node);
	});
	const declarations = probeDeclarationTypes(
		input,
		headers,
		collectDeclarations(nodes, cwd, isLibraryFile, layouts),
	);

	const probes = probe(input, headers.valueProbe, headers.candidates);
	const nativeTypes = probeTypeMetadata(input, headers, declarations, probes.target);

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
		globals: declarations.globals.sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		),
		records: nativeTypes.records,
		enums: nativeTypes.enums,
		typedefs: nativeTypes.typedefs,
	};
	const sources = new SourceTexts();
	const macros: Array<CMacro> = [];
	const untypedMacros: Array<CUntypedMacro> = [];
	const located = (macro: PreprocessedMacro): CLocation => ({
		file: path.resolve(cwd, macro.file),
		line: macro.line,
	});
	const documentedMacro = (macro: PreprocessedMacro): CUntypedMacro => {
		const location = located(macro);
		const lines = sources.lines(location.file);
		const doc =
			macroComment(lines, location.line) ?? commentBlockAbove(lines, location.line)?.text;
		return {
			name: macro.name,
			body: macro.body,
			...probes.expansions.get(macro.name),
			library: isLibraryFile(path.resolve(cwd, macro.file)),
			...(macro.parameters === undefined ? {} : { parameters: macro.parameters }),
			...(macro.variadic === undefined ? {} : { variadic: macro.variadic }),
			location,
			...(doc === undefined ? {} : { doc }),
		};
	};
	const probed = new Set(headers.candidates.map((macro) => macro.name));
	for (const macro of headers.definitions)
		if (!probed.has(macro.name)) untypedMacros.push(documentedMacro(macro));
	for (const macro of probes.untyped) {
		untypedMacros.push(documentedMacro(macro));
	}
	for (const entry of probes.typed) {
		const documented = documentedMacro(entry.macro);
		const resolved = resolveCType(base, entry.type);
		// A macro that aliases a function or an unsupported type is not a constant.
		if (resolved.kind === "function" || resolved.kind === "unsupported") {
			untypedMacros.push(documented);
			continue;
		}
		const integral =
			resolved.kind === "integer" || resolved.kind === "bool" || resolved.kind === "enum";
		const value =
			documented.contextual === true
				? undefined
				: integral
					? entry.integer
					: entry.literal;
		macros.push({
			...documented,
			type: entry.type,
			...(value === undefined ? {} : { value }),
		});
	}
	headers.validate();
	return { ...base, macros, untypedMacros };
}
