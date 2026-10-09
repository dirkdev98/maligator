/**
 * Outlines dominator regions of an oversized native C function into noinline parts,
 * because Clang's backend time grows superlinearly with function size. The pass runs
 * after rendering and moves whole labeled blocks, so instruction lowering is unchanged.
 *
 * Every part is a union of dominator subtrees, so control enters it only at their
 * roots. Callers pass the values live at an entry through a per-activation transfer
 * struct; a part returns an exit code naming where to continue, with the live values
 * it may have written. Both sides keep those values in C locals, while the root frame
 * and shadow slots stay shared, so root publication and inactive masks are unchanged.
 * Loops that fit one part keep their bodies in the header's part.
 */

export interface NativeSplitPolicy {
	/** Bodies up to this many code units stay whole. */
	readonly thresholdCodeUnits: number;
	/** Code units each outlined part aims to stay within. */
	readonly partCodeUnits: number;
}

export const DEFAULT_NATIVE_SPLIT_POLICY: NativeSplitPolicy = Object.freeze({
	thresholdCodeUnits: 256 * 1024,
	partCodeUnits: 128 * 1024,
});

/** One rendered native function, divided at the boundaries the splitter needs. */
export interface NativeSplitSource {
	readonly symbol: string;
	/** The opening line of the definition, ending in `{`. */
	readonly signature: string;
	readonly resultType: string;
	/** A function-scope `__gc_inactive_rows` table; parts need it at file scope. */
	readonly inactiveRows: ReadonlyArray<string>;
	/** Declarations, register macros and entry statements before the body. */
	readonly prologue: ReadonlyArray<string>;
	/** State declarations followed by one emission unit per instruction. */
	readonly body: ReadonlyArray<string>;
	/** Body line index of every emission unit; earlier lines are state declarations. */
	readonly unitStarts: ReadonlyArray<number>;
	/** Statements reached by falling off the end of the body. */
	readonly fallOff: ReadonlyArray<string>;
	/** Unused label for the fall-off statements. */
	readonly fallOffLabel: string;
	/** The `__throw_exit` label and its statements, when the body uses it. */
	readonly throwExit: ReadonlyArray<string>;
	/** Preprocessor lines that follow the closing brace. */
	readonly trailer: ReadonlyArray<string>;
}

/** Returns the lines of the split definition, or undefined to keep the function whole. */
export function splitNativeFunction(
	source: NativeSplitSource,
	policy: NativeSplitPolicy = DEFAULT_NATIVE_SPLIT_POLICY,
): Array<string> | undefined {
	let bodyCodeUnits = 0;
	for (const line of source.body) bodyCodeUnits += line.length + 1;
	if (bodyCodeUnits <= policy.thresholdCodeUnits || source.unitStarts.length === 0)
		return undefined;
	try {
		const frame = buildFrame(source);
		const graph = scanBlocks(source, frame);
		let prologueCodeUnits = 0;
		for (const line of source.prologue) prologueCodeUnits += line.length + 1;
		const partition = partitionBlocks(graph, policy, prologueCodeUnits);
		if (partition.functions.length === 1) return undefined;
		verifyPartition(graph, partition);
		const interfaces = planInterfaces(graph, partition, frame);
		return renderSplit(source, frame, graph, partition, interfaces);
	} catch (error) {
		if (error instanceof SplitDeclined) return undefined;
		throw error;
	}
}

/** The body uses a shape this pass does not move between functions. */
class SplitDeclined extends Error {}

function decline(reason: string): never {
	throw new SplitDeclined(reason);
}

const SPECIAL_GC_SLOTS = 1;
const SPECIAL_GC_FRAME = 2;
const SPECIAL_INACTIVE_ROWS = 4;
const SPECIAL_GC_DESC = 8;

const SPECIAL_NAMES: ReadonlyMap<string, number> = new Map([
	["__gc_slots", SPECIAL_GC_SLOTS],
	["__gc_frame", SPECIAL_GC_FRAME],
	["__gc_inactive_rows", SPECIAL_INACTIVE_ROWS],
	["__gc_desc", SPECIAL_GC_DESC],
	["MAL_ROOT_MASK", SPECIAL_GC_FRAME],
	["MAL_ROOT_MASK_ROW", SPECIAL_GC_FRAME | SPECIAL_INACTIVE_ROWS],
]);

const SCALAR_TYPES = new Set([
	"bool",
	"char",
	"double",
	"f32",
	"f64",
	"float",
	"i16",
	"i32",
	"i64",
	"i8",
	"int",
	"isize",
	"MalPrivateRoot",
	"MalValue",
	"u16",
	"u32",
	"u64",
	"u8",
	"uptr",
	"usize",
]);

interface FrameLocal {
	readonly name: string;
	/** Type of a modifiable copy: storage class and top-level `const` removed. */
	readonly type: string;
	/** Declared type without storage class, for references to the caller's storage. */
	readonly declared: string;
	readonly array: string | undefined;
	/** Scalars move between functions by value; aggregates are shared by address. */
	readonly value: boolean;
}

interface Meaning {
	readonly values: ReadonlyArray<number>;
	readonly objects: ReadonlyArray<number>;
	readonly specials: number;
	/** The value local an assignment to this spelling writes, or -1. */
	readonly target: number;
}

interface Frame {
	readonly locals: ReadonlyArray<FrameLocal>;
	readonly meanings: ReadonlyMap<string, Meaning>;
	/** Value locals whose address the prologue exposes. */
	readonly addressed: ReadonlySet<number>;
}

function frameLocal(
	name: string,
	declaredType: string,
	array: string | undefined,
): FrameLocal {
	let declared = declaredType;
	while (declared.startsWith("static ")) declared = declared.slice(7);
	let copy = declared;
	if (copy.endsWith(" const")) copy = copy.slice(0, -6);
	if (copy.startsWith("const ") && !copy.includes("*")) copy = copy.slice(6);
	const value = array === undefined && (copy.endsWith("*") || SCALAR_TYPES.has(copy));
	return { name, type: copy, declared, array, value };
}

/**
 * Collects every function-scope local a block may name: parameters, prologue
 * declarations and body state declarations. Register macros resolve to the locals
 * and shadow-frame storage their bodies name.
 */
function buildFrame(source: NativeSplitSource): Frame {
	const locals: Array<FrameLocal> = [];
	const meanings = new Map<string, Meaning>();
	const add = (local: FrameLocal) => {
		if (local.name === "vm" || SPECIAL_NAMES.has(local.name)) return;
		if (meanings.has(local.name)) decline(`duplicate frame local ${local.name}`);
		const id = locals.length;
		locals.push(local);
		meanings.set(
			local.name,
			local.value
				? { values: [id], objects: [], specials: 0, target: id }
				: { values: [], objects: [id], specials: 0, target: -1 },
		);
	};
	for (const parameter of signatureParameters(source.signature))
		for (const local of parseDeclaration(`${parameter};`, true)!) add(local);
	const macros = new Map<string, string>();
	const tokens = new CTokenizer();
	let depth = 0;
	for (const line of source.prologue) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) {
			if (trimmed.startsWith("#define ")) {
				const definition = trimmed.slice(8);
				const space = definition.indexOf(" ");
				const name = space < 0 ? definition : definition.slice(0, space);
				if (name.includes("(")) decline(`function-like prologue macro ${name}`);
				macros.set(name, space < 0 ? "" : definition.slice(space + 1));
			}
			continue;
		}
		if (depth === 0)
			for (const local of parseDeclaration(trimmed, false) ?? []) add(local);
		tokens.reset(line);
		for (let kind = tokens.next(); kind !== TOKEN_END; kind = tokens.next()) {
			if (kind === TOKEN_LPAREN || kind === TOKEN_LBRACKET || kind === TOKEN_LBRACE)
				depth++;
			else if (kind === TOKEN_RPAREN || kind === TOKEN_RBRACKET || kind === TOKEN_RBRACE)
				depth--;
		}
	}
	if (depth !== 0) decline("unbalanced prologue");
	for (let line = 0; line < source.unitStarts[0]!; line++)
		for (const local of parseDeclaration(source.body[line]!.trim(), true)!) add(local);
	for (const [name, specials] of SPECIAL_NAMES)
		meanings.set(name, { values: [], objects: [], specials, target: -1 });
	const expanding = new Set<string>();
	const expand = (name: string): Meaning | undefined => {
		const known = meanings.get(name);
		if (known !== undefined || !macros.has(name)) return known;
		if (expanding.has(name)) decline(`recursive prologue macro ${name}`);
		expanding.add(name);
		const meaning = macroMeaning(macros.get(name)!, expand);
		expanding.delete(name);
		meanings.set(name, meaning);
		return meaning;
	};
	for (const name of macros.keys()) expand(name);
	const addressed = new Set<number>();
	for (const line of source.prologue) {
		if (line.trim().startsWith("#")) continue;
		tokens.reset(line);
		let previous = TOKEN_END;
		let beforePrevious = TOKEN_END;
		let pending: Meaning | undefined;
		for (let kind = tokens.next(); ; kind = tokens.next()) {
			if (
				pending !== undefined &&
				kind !== TOKEN_ARROW &&
				kind !== TOKEN_LBRACKET &&
				kind !== TOKEN_DOT
			)
				addressed.add(pending.target);
			pending = undefined;
			if (kind === TOKEN_END) break;
			if (
				kind === TOKEN_IDENTIFIER &&
				previous === TOKEN_AMPERSAND &&
				!isOperandEnd(beforePrevious)
			) {
				const meaning = meanings.get(tokens.text);
				if (meaning !== undefined && meaning.target >= 0) pending = meaning;
			}
			beforePrevious = previous;
			previous = kind;
		}
	}
	return { locals, meanings, addressed };
}

function signatureParameters(signature: string): Array<string> {
	const open = signature.indexOf(
		"(",
		signature.indexOf("__attribute__((aligned(64)))") + 28,
	);
	if (open < 0) decline("unrecognized signature");
	const parameters: Array<string> = [];
	let depth = 0;
	let start = open + 1;
	for (let at = open; at < signature.length; at++) {
		const code = signature.charCodeAt(at);
		if (code === 40) depth++;
		else if (code === 41 && --depth === 0) {
			parameters.push(signature.slice(start, at).trim());
			return parameters;
		} else if (code === 44 && depth === 1) {
			parameters.push(signature.slice(start, at).trim());
			start = at + 1;
		}
	}
	decline("unterminated signature");
}

/**
 * Declarators of one generated statement, or undefined when it is not a
 * declaration. Declaration-shaped text that cannot be parsed declines the split.
 */
function parseDeclaration(
	text: string,
	required: boolean,
): Array<FrameLocal> | undefined {
	const tokens = new CTokenizer();
	tokens.reset(text);
	const kinds: Array<number> = [];
	const texts: Array<string> = [];
	const starts: Array<number> = [];
	const ends: Array<number> = [];
	for (let kind = tokens.next(); kind !== TOKEN_END; kind = tokens.next()) {
		kinds.push(kind);
		texts.push(kind === TOKEN_IDENTIFIER ? tokens.text : "");
		starts.push(tokens.start);
		ends.push(tokens.end);
	}
	let index = 0;
	const typeTokens: Array<string> = [];
	while (
		index < kinds.length &&
		(kinds[index] === TOKEN_IDENTIFIER || kinds[index] === TOKEN_STAR)
	) {
		typeTokens.push(kinds[index] === TOKEN_STAR ? "*" : texts[index]!);
		index++;
	}
	const terminator = kinds[index];
	const shaped =
		typeTokens.filter((token) => token !== "*").length >= 2 &&
		typeTokens[typeTokens.length - 1] !== "*" &&
		!KEYWORDS.has(typeTokens[0]!) &&
		(terminator === TOKEN_ASSIGN ||
			terminator === TOKEN_SEMICOLON ||
			terminator === TOKEN_LBRACKET ||
			terminator === TOKEN_COMMA);
	if (!shaped) {
		if (required) decline(`unrecognized declaration: ${text}`);
		return undefined;
	}
	const fail = (): never => decline(`unrecognized declaration: ${text}`);
	const declarators: Array<FrameLocal> = [];
	let name = typeTokens.pop()!;
	let base = typeTokens;
	while (base.length > 0 && base[base.length - 1] === "*") base = base.slice(0, -1);
	let type = typeTokens.join(" ");
	for (;;) {
		let array: string | undefined;
		if (kinds[index] === TOKEN_LBRACKET) {
			const start = starts[index]!;
			let end = start;
			while (kinds[index] === TOKEN_LBRACKET) {
				let depth = 0;
				for (; index < kinds.length; index++) {
					if (kinds[index] === TOKEN_LBRACKET) depth++;
					else if (kinds[index] === TOKEN_RBRACKET && --depth === 0) break;
				}
				if (index >= kinds.length) fail();
				end = ends[index]!;
				index++;
			}
			array = text.slice(start, end);
		}
		declarators.push(frameLocal(name, type, array));
		if (kinds[index] === TOKEN_ASSIGN) {
			let depth = 0;
			for (index++; index < kinds.length; index++) {
				const kind = kinds[index]!;
				if (kind === TOKEN_LPAREN || kind === TOKEN_LBRACKET || kind === TOKEN_LBRACE)
					depth++;
				else if (
					kind === TOKEN_RPAREN ||
					kind === TOKEN_RBRACKET ||
					kind === TOKEN_RBRACE
				)
					depth--;
				else if (depth === 0 && (kind === TOKEN_COMMA || kind === TOKEN_SEMICOLON)) break;
			}
		}
		if (kinds[index] === TOKEN_SEMICOLON && index === kinds.length - 1)
			return declarators;
		if (kinds[index] !== TOKEN_COMMA) fail();
		index++;
		const stars: Array<string> = [];
		while (kinds[index] === TOKEN_STAR) {
			stars.push("*");
			index++;
		}
		if (kinds[index] !== TOKEN_IDENTIFIER) fail();
		name = texts[index]!;
		type = [...base, ...stars].join(" ");
		index++;
	}
}

const TOKEN_END = 0;
const TOKEN_IDENTIFIER = 1;
const TOKEN_NUMBER = 2;
const TOKEN_STRING = 3;
const TOKEN_LPAREN = 4;
const TOKEN_RPAREN = 5;
const TOKEN_LBRACKET = 6;
const TOKEN_RBRACKET = 7;
const TOKEN_LBRACE = 8;
const TOKEN_RBRACE = 9;
const TOKEN_SEMICOLON = 10;
const TOKEN_COMMA = 11;
const TOKEN_ASSIGN = 12;
const TOKEN_COMPOUND_ASSIGN = 13;
const TOKEN_INCREMENT = 14;
const TOKEN_AMPERSAND = 15;
const TOKEN_ARROW = 16;
const TOKEN_DOT = 17;
const TOKEN_COLON = 18;
const TOKEN_STAR = 19;
const TOKEN_OTHER = 20;

function isIdentifierStart(code: number): boolean {
	return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95;
}

function isIdentifierPart(code: number): boolean {
	return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

/** A tokenizer for the C the native renderer emits; block comments may span lines. */
class CTokenizer {
	text = "";
	start = 0;
	end = 0;
	private line = "";
	private inComment = false;

	reset(line: string): void {
		this.line = line;
		this.end = 0;
	}

	next(): number {
		const line = this.line;
		let at = this.end;
		for (;;) {
			if (this.inComment) {
				const close = line.indexOf("*/", at);
				if (close < 0) {
					this.end = line.length;
					return TOKEN_END;
				}
				this.inComment = false;
				at = close + 2;
			}
			while (at < line.length && line.charCodeAt(at) <= 32) at++;
			if (at >= line.length) {
				this.end = at;
				return TOKEN_END;
			}
			const code = line.charCodeAt(at);
			if (code === 47 /* / */) {
				const following = line.charCodeAt(at + 1);
				if (following === 47) {
					this.end = line.length;
					return TOKEN_END;
				}
				if (following === 42) {
					this.inComment = true;
					at += 2;
					continue;
				}
			}
			break;
		}
		this.start = at;
		const code = line.charCodeAt(at);
		if (isIdentifierStart(code)) {
			let end = at + 1;
			while (end < line.length && isIdentifierPart(line.charCodeAt(end))) end++;
			this.end = end;
			this.text = line.slice(at, end);
			return TOKEN_IDENTIFIER;
		}
		if (code >= 48 && code <= 57) {
			let end = at + 1;
			while (end < line.length) {
				const part = line.charCodeAt(end);
				if (!isIdentifierPart(part) && part !== 46) break;
				end++;
			}
			this.end = end;
			return TOKEN_NUMBER;
		}
		if (code === 34 || code === 39) {
			let end = at + 1;
			while (end < line.length && line.charCodeAt(end) !== code)
				end += line.charCodeAt(end) === 92 ? 2 : 1;
			this.end = Math.min(end + 1, line.length);
			return TOKEN_STRING;
		}
		const next = line.charCodeAt(at + 1);
		this.end = at + 1;
		switch (code) {
			case 40:
				return TOKEN_LPAREN;
			case 41:
				return TOKEN_RPAREN;
			case 91:
				return TOKEN_LBRACKET;
			case 93:
				return TOKEN_RBRACKET;
			case 123:
				return TOKEN_LBRACE;
			case 125:
				return TOKEN_RBRACE;
			case 59:
				return TOKEN_SEMICOLON;
			case 44:
				return TOKEN_COMMA;
			case 58:
				return TOKEN_COLON;
			case 46:
				return TOKEN_DOT;
			case 61 /* = */:
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_OTHER;
				}
				return TOKEN_ASSIGN;
			case 43 /* + */:
			case 45 /* - */:
				if (next === code) {
					this.end = at + 2;
					return TOKEN_INCREMENT;
				}
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_COMPOUND_ASSIGN;
				}
				if (code === 45 && next === 62) {
					this.end = at + 2;
					return TOKEN_ARROW;
				}
				return TOKEN_OTHER;
			case 38 /* & */:
				if (next === 38) {
					this.end = at + 2;
					return TOKEN_OTHER;
				}
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_COMPOUND_ASSIGN;
				}
				return TOKEN_AMPERSAND;
			case 42 /* * */:
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_COMPOUND_ASSIGN;
				}
				return TOKEN_STAR;
			case 60 /* < */:
			case 62 /* > */:
				if (next === code) {
					const third = line.charCodeAt(at + 2);
					this.end = third === 61 ? at + 3 : at + 2;
					return third === 61 ? TOKEN_COMPOUND_ASSIGN : TOKEN_OTHER;
				}
				if (next === 61) this.end = at + 2;
				return TOKEN_OTHER;
			case 33 /* ! */:
				if (next === 61) this.end = at + 2;
				return TOKEN_OTHER;
			case 47 /* / */:
			case 37 /* % */:
			case 94 /* ^ */:
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_COMPOUND_ASSIGN;
				}
				return TOKEN_OTHER;
			case 124 /* | */:
				if (next === 124) {
					this.end = at + 2;
					return TOKEN_OTHER;
				}
				if (next === 61) {
					this.end = at + 2;
					return TOKEN_COMPOUND_ASSIGN;
				}
				return TOKEN_OTHER;
			default:
				return TOKEN_OTHER;
		}
	}
}

const OP_USE = 0;
const OP_KILL = 1;
/** Control may leave for the block or continue. */
const OP_EXIT = 2;
/** Control leaves for the block and never continues. */
const OP_JUMP = 3;
const OP_RETURN = 4;
/** Live values before are the union over arms; an empty arm passes values through. */
const OP_BRANCH = 5;

type LiveOp =
	| { readonly op: typeof OP_USE | typeof OP_KILL; readonly id: number }
	| { readonly op: typeof OP_EXIT | typeof OP_JUMP; readonly block: number }
	| { readonly op: typeof OP_RETURN }
	| {
			readonly op: typeof OP_BRANCH;
			readonly arms: ReadonlyArray<ReadonlyArray<LiveOp>>;
	  };

const RETURN_OP: LiveOp = { op: OP_RETURN };

interface Block {
	/** Lines of this block, starting with its label line unless it is the entry. */
	readonly lines: ReadonlyArray<string>;
	readonly label: string | undefined;
	readonly size: number;
	/** Backward-liveness program over frame value ids, in execution order. */
	readonly ops: ReadonlyArray<LiveOp>;
	readonly targets: ReadonlyArray<number>;
	readonly fallsThrough: boolean;
	readonly usesThrowExit: boolean;
	/** Value locals named anywhere in the block. */
	readonly mentions: ReadonlyArray<number>;
	readonly objects: ReadonlyArray<number>;
	readonly specials: number;
	/** Value locals the block may assign, increment or expose by address. */
	readonly writes: ReadonlyArray<number>;
}

interface Graph {
	readonly blocks: ReadonlyArray<Block>;
	readonly successors: ReadonlyArray<ReadonlyArray<number>>;
	readonly throwExit: {
		readonly objects: ReadonlyArray<number>;
		readonly specials: number;
	};
	/** Value locals shared by address because some statement exposes their address. */
	readonly addressed: ReadonlySet<number>;
}

const KEYWORDS = new Set([
	"break",
	"case",
	"continue",
	"default",
	"do",
	"else",
	"for",
	"goto",
	"if",
	"return",
	"switch",
	"while",
]);

function sameMeaning(left: Meaning | undefined, right: Meaning | undefined): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	return (
		left.target === right.target &&
		left.specials === right.specials &&
		left.values.join() === right.values.join() &&
		left.objects.join() === right.objects.join()
	);
}

function macroMeaning(
	body: string,
	lookup: (name: string) => Meaning | undefined,
): Meaning {
	const values = new Set<number>();
	const objects = new Set<number>();
	let specials = 0;
	const tokens = new CTokenizer();
	tokens.reset(body);
	const identifiers: Array<string> = [];
	let count = 0;
	let previous = TOKEN_END;
	for (let kind = tokens.next(); kind !== TOKEN_END; kind = tokens.next()) {
		count++;
		const member = previous === TOKEN_DOT || previous === TOKEN_ARROW;
		previous = kind;
		if (kind !== TOKEN_IDENTIFIER || member) continue;
		identifiers.push(tokens.text);
		const meaning = lookup(tokens.text);
		if (meaning === undefined) continue;
		for (const id of meaning.values) values.add(id);
		for (const id of meaning.objects) objects.add(id);
		specials |= meaning.specials;
	}
	const direct =
		identifiers.length === 1 && (count === 1 || count === 3)
			? lookup(identifiers[0]!)
			: undefined;
	return {
		values: [...values],
		objects: [...objects],
		specials,
		target: direct?.target ?? -1,
	};
}

/**
 * Parses one block of generated statements into a liveness program and the facts
 * partitioning needs. Assignments count as kills only as whole statements in the
 * sequence that contains them; an if/else keeps its arms apart so a value both
 * arms assign is killed. Loops and switches are summarized without kills.
 */
class BlockParser {
	private readonly tokens = new CTokenizer();
	private readonly mentionStamp: Uint32Array;
	private readonly objectStamp: Uint32Array;
	private readonly writeStamp: Uint32Array;
	private readonly targetStamp: Uint32Array;
	private readonly frame: Frame;
	private readonly labels: ReadonlyMap<string, number>;
	private readonly declared: Map<string, number>;
	private readonly overrides = new Map<string, Meaning | undefined>();
	/** Value locals whose address escapes; a part must use the caller's storage. */
	readonly addressed = new Set<number>();
	private stamp = 0;
	private kinds: Array<number> = [];
	private texts: Array<string> = [];
	private meanings: Array<Meaning | undefined> = [];
	/** Whether each token sits inside conditional compilation. */
	private conditional: Array<boolean> = [];
	private at = 0;
	private block = 0;
	private scopeDepth = 0;
	private mentions: Array<number> = [];
	private objects: Array<number> = [];
	private writes: Array<number> = [];
	private targets: Array<number> = [];
	private specials = 0;
	private usesThrowExit = false;

	constructor(
		frame: Frame,
		labels: ReadonlyMap<string, number>,
		declared: Map<string, number>,
	) {
		this.frame = frame;
		this.labels = labels;
		this.declared = declared;
		const count = frame.locals.length;
		this.mentionStamp = new Uint32Array(count);
		this.objectStamp = new Uint32Array(count);
		this.writeStamp = new Uint32Array(count);
		this.targetStamp = new Uint32Array(labels.size + 1);
	}

	parse(
		lines: ReadonlyArray<string>,
		first: number,
		block: number,
	): Omit<Block, "lines" | "label" | "size"> {
		this.stamp++;
		this.block = block;
		this.mentions = [];
		this.objects = [];
		this.writes = [];
		this.targets = [];
		this.specials = 0;
		this.usesThrowExit = false;
		this.tokenize(lines, first);
		this.scopeDepth = 0;
		const ops: Array<LiveOp> = [];
		const terminates = this.sequence(ops, false, false);
		return {
			ops,
			targets: this.targets,
			fallsThrough: !terminates,
			usesThrowExit: this.usesThrowExit,
			mentions: this.mentions,
			objects: this.objects,
			specials: this.specials,
			writes: this.writes,
		};
	}

	private lookup(name: string): Meaning | undefined {
		return this.overrides.size !== 0 && this.overrides.has(name)
			? this.overrides.get(name)
			: this.frame.meanings.get(name);
	}

	private tokenize(lines: ReadonlyArray<string>, first: number): void {
		const kinds: Array<number> = [];
		const texts: Array<string> = [];
		const meanings: Array<Meaning | undefined> = [];
		const conditional: Array<boolean> = [];
		let conditionalDepth = 0;
		this.overrides.clear();
		for (let index = first; index < lines.length; index++) {
			const line = lines[index]!;
			const trimmed = line.trim();
			if (trimmed.startsWith("#")) {
				if (trimmed.startsWith("#define ")) {
					const definition = trimmed.slice(8);
					const space = definition.indexOf(" ");
					if (space < 0) decline(`empty macro in block ${this.block}`);
					const name = definition.slice(0, space);
					if (name.includes("(")) decline(`function-like macro in block ${this.block}`);
					this.overrides.set(
						name,
						macroMeaning(definition.slice(space + 1), (identifier) =>
							this.lookup(identifier),
						),
					);
				} else if (trimmed.startsWith("#undef "))
					this.overrides.set(trimmed.slice(7).trim(), undefined);
				else if (trimmed.startsWith("#if")) conditionalDepth++;
				else if (trimmed.startsWith("#endif")) {
					if (--conditionalDepth < 0) decline(`unbalanced #endif in block ${this.block}`);
				} else if (!trimmed.startsWith("#else") && !trimmed.startsWith("#elif"))
					decline(`preprocessor line in block ${this.block}`);
				continue;
			}
			this.tokens.reset(line);
			for (let kind = this.tokens.next(); kind !== TOKEN_END; kind = this.tokens.next()) {
				kinds.push(kind);
				conditional.push(conditionalDepth > 0);
				if (kind === TOKEN_IDENTIFIER) {
					const text = this.tokens.text;
					texts.push(text);
					meanings.push(this.lookup(text));
				} else {
					texts.push("");
					meanings.push(undefined);
				}
			}
		}
		if (conditionalDepth !== 0) decline(`unterminated #if in block ${this.block}`);
		for (const [name, meaning] of this.overrides)
			if (!sameMeaning(meaning, this.frame.meanings.get(name)))
				decline(`macro ${name} changes across block ${this.block}`);
		this.kinds = kinds;
		this.texts = texts;
		this.meanings = meanings;
		this.conditional = conditional;
		this.at = 0;
	}

	private expect(kind: number): void {
		if (this.kinds[this.at] !== kind) decline(`unexpected token in block ${this.block}`);
		this.at++;
	}

	private keyword(offset = 0): string | undefined {
		const index = this.at + offset;
		return this.kinds[index] === TOKEN_IDENTIFIER && KEYWORDS.has(this.texts[index]!)
			? this.texts[index]
			: undefined;
	}

	/** Parses statements up to a closing brace (consumed) or the end; true when control cannot fall out. */
	private sequence(ops: Array<LiveOp>, braced: boolean, opaque: boolean): boolean {
		let terminated = false;
		for (;;) {
			if (this.at >= this.kinds.length) {
				if (braced) decline(`unterminated block in ${this.block}`);
				return terminated;
			}
			if (braced && this.kinds[this.at] === TOKEN_RBRACE) {
				this.at++;
				return terminated;
			}
			// Without labels in a block, statements after a jump are dead unless a switch case reaches them.
			const statement: Array<LiveOp> = [];
			const ends = this.statement(statement, opaque);
			if (opaque || !terminated) for (const op of statement) ops.push(op);
			if (ends) terminated = true;
		}
	}

	private statement(ops: Array<LiveOp>, opaque: boolean): boolean {
		if (this.conditional[this.at] === true) {
			// The build may compile this statement out, so it neither kills nor ends the sequence.
			const maybe: Array<LiveOp> = [];
			this.unconditionalStatement(maybe, opaque);
			flattenInto(ops, maybe);
			return false;
		}
		return this.unconditionalStatement(ops, opaque);
	}

	private unconditionalStatement(ops: Array<LiveOp>, opaque: boolean): boolean {
		const kind = this.kinds[this.at];
		if (kind === TOKEN_SEMICOLON) {
			this.at++;
			return false;
		}
		if (kind === TOKEN_LBRACE) {
			this.at++;
			this.scopeDepth++;
			const ends = this.sequence(ops, true, opaque);
			this.scopeDepth--;
			return ends;
		}
		switch (this.keyword()) {
			case "if": {
				this.at++;
				this.parenthesized(ops);
				const then: Array<LiveOp> = [];
				const thenEnds = this.statement(then, opaque);
				const otherwise: Array<LiveOp> = [];
				let otherwiseEnds = false;
				const hasElse = this.keyword() === "else";
				if (hasElse) {
					this.at++;
					otherwiseEnds = this.statement(otherwise, opaque);
				}
				if (opaque || (!hasKill(then) && !hasKill(otherwise))) {
					flattenInto(ops, then);
					flattenInto(ops, otherwise);
				} else ops.push({ op: OP_BRANCH, arms: [then, otherwise] });
				return hasElse && thenEnds && otherwiseEnds;
			}
			case "switch":
			case "while": {
				this.at++;
				this.parenthesized(ops);
				const body: Array<LiveOp> = [];
				this.statement(body, true);
				flattenInto(ops, body);
				return false;
			}
			case "for": {
				this.at++;
				const head: Array<LiveOp> = [];
				this.parenthesized(head);
				const body: Array<LiveOp> = [];
				this.statement(body, true);
				flattenInto(ops, head);
				flattenInto(ops, body);
				return false;
			}
			case "do": {
				this.at++;
				const body: Array<LiveOp> = [];
				this.statement(body, true);
				if (this.keyword() !== "while") decline(`malformed do in block ${this.block}`);
				this.at++;
				this.parenthesized(body);
				this.expect(TOKEN_SEMICOLON);
				flattenInto(ops, body);
				return false;
			}
			case "goto": {
				this.at++;
				const jump = this.gotoTarget();
				this.expect(TOKEN_SEMICOLON);
				ops.push(jump);
				return true;
			}
			case "return":
				this.at++;
				this.expression(ops, TOKEN_SEMICOLON);
				this.at++;
				ops.push(RETURN_OP);
				return true;
			case "break":
			case "continue":
				if (!opaque) decline(`loop control outside a loop in block ${this.block}`);
				this.at++;
				this.expect(TOKEN_SEMICOLON);
				return true;
			case "case":
				if (!opaque) decline(`case outside a switch in block ${this.block}`);
				this.at++;
				this.expression(ops, TOKEN_COLON);
				this.at++;
				return false;
			case "default":
				if (!opaque) decline(`default outside a switch in block ${this.block}`);
				this.at++;
				this.expect(TOKEN_COLON);
				return false;
			case "else":
				decline(`dangling else in block ${this.block}`);
		}
		if (kind === TOKEN_IDENTIFIER && this.kinds[this.at + 1] === TOKEN_COLON)
			decline(`interior label in block ${this.block}`);
		this.simpleStatement(ops);
		return false;
	}

	private gotoTarget(): LiveOp {
		if (this.kinds[this.at] !== TOKEN_IDENTIFIER)
			decline(`malformed goto in block ${this.block}`);
		const label = this.texts[this.at]!;
		this.at++;
		if (label === "__throw_exit") {
			this.usesThrowExit = true;
			return RETURN_OP;
		}
		const block = this.labels.get(label);
		if (block === undefined) decline(`unknown label ${label}`);
		if (this.targetStamp[block] !== this.stamp) {
			this.targetStamp[block] = this.stamp;
			this.targets.push(block);
		}
		return { op: OP_JUMP, block };
	}

	private parenthesized(ops: Array<LiveOp>): void {
		this.expect(TOKEN_LPAREN);
		this.expression(ops, TOKEN_RPAREN);
		this.at++;
	}

	private simpleStatement(ops: Array<LiveOp>): void {
		const { kinds, texts } = this;
		let index = this.at;
		let identifiers = 0;
		while (kinds[index] === TOKEN_IDENTIFIER || kinds[index] === TOKEN_STAR) {
			if (kinds[index] === TOKEN_IDENTIFIER) identifiers++;
			index++;
		}
		const terminator = kinds[index];
		if (
			identifiers >= 2 &&
			kinds[index - 1] === TOKEN_IDENTIFIER &&
			(terminator === TOKEN_ASSIGN ||
				terminator === TOKEN_SEMICOLON ||
				terminator === TOKEN_LBRACKET ||
				terminator === TOKEN_COMMA)
		) {
			this.declareTemporary(texts[index - 1]!);
			this.at = index;
			for (;;) {
				if (kinds[this.at] === TOKEN_LBRACKET) {
					this.at++;
					this.expression(ops, TOKEN_RBRACKET);
					this.at++;
					continue;
				}
				if (kinds[this.at] === TOKEN_ASSIGN) {
					this.at++;
					this.expression(ops, TOKEN_SEMICOLON, TOKEN_COMMA);
					continue;
				}
				if (kinds[this.at] === TOKEN_COMMA) {
					this.at++;
					while (kinds[this.at] === TOKEN_STAR) this.at++;
					if (kinds[this.at] !== TOKEN_IDENTIFIER)
						decline(`malformed declaration in block ${this.block}`);
					this.declareTemporary(texts[this.at]!);
					this.at++;
					continue;
				}
				this.expect(TOKEN_SEMICOLON);
				return;
			}
		}
		const meaning = this.meanings[this.at];
		if (
			kinds[this.at] === TOKEN_IDENTIFIER &&
			kinds[this.at + 1] === TOKEN_ASSIGN &&
			meaning !== undefined &&
			meaning.target >= 0
		) {
			this.checkTemporary(texts[this.at]!);
			this.mention(meaning);
			this.write(meaning.target);
			this.at += 2;
			this.expression(ops, TOKEN_SEMICOLON);
			this.at++;
			ops.push({ op: OP_KILL, id: meaning.target });
			return;
		}
		this.expression(ops, TOKEN_SEMICOLON);
		this.at++;
	}

	/** Consumes an expression up to a top-level stop token, which stays unconsumed. */
	private expression(ops: Array<LiveOp>, stop: number, alternative = -1): void {
		const { kinds, texts, meanings } = this;
		let depth = 0;
		for (;;) {
			const at = this.at;
			if (at >= kinds.length) decline(`unterminated expression in block ${this.block}`);
			const kind = kinds[at]!;
			if (depth === 0 && (kind === stop || kind === alternative)) return;
			this.at++;
			switch (kind) {
				case TOKEN_LPAREN:
				case TOKEN_LBRACKET:
				case TOKEN_LBRACE:
					depth++;
					continue;
				case TOKEN_RPAREN:
				case TOKEN_RBRACKET:
				case TOKEN_RBRACE:
					if (--depth < 0) decline(`unbalanced expression in block ${this.block}`);
					continue;
				case TOKEN_IDENTIFIER:
					break;
				default:
					continue;
			}
			const previous = at > 0 ? kinds[at - 1]! : TOKEN_END;
			if (previous === TOKEN_DOT || previous === TOKEN_ARROW) continue;
			const text = texts[at]!;
			if (text === "goto") {
				// A statement expression may branch away; whatever follows can still run.
				const jump = this.gotoTarget();
				if (jump.op === OP_JUMP) ops.push({ op: OP_EXIT, block: jump.block });
				continue;
			}
			this.checkTemporary(text);
			const meaning = meanings[at];
			if (meaning === undefined) continue;
			this.mention(meaning);
			const next = kinds[at + 1] ?? TOKEN_END;
			const beforePrevious = at > 1 ? kinds[at - 2]! : TOKEN_END;
			const unary = !isOperandEnd(beforePrevious);
			const dereferenced = previous === TOKEN_STAR && unary;
			const address = previous === TOKEN_AMPERSAND && unary;
			const prefixIncrement = previous === TOKEN_INCREMENT && unary;
			const pureWrite =
				next === TOKEN_ASSIGN && !address && !prefixIncrement && !dereferenced;
			const writes =
				pureWrite ||
				(!dereferenced &&
					(next === TOKEN_COMPOUND_ASSIGN ||
						next === TOKEN_INCREMENT ||
						prefixIncrement ||
						(address &&
							next !== TOKEN_ARROW &&
							next !== TOKEN_LBRACKET &&
							next !== TOKEN_DOT)));
			if (writes && meaning.target >= 0) this.write(meaning.target);
			if (
				address &&
				meaning.target >= 0 &&
				next !== TOKEN_ARROW &&
				next !== TOKEN_LBRACKET &&
				next !== TOKEN_DOT
			)
				this.addressed.add(meaning.target);
			if (!pureWrite) for (const id of meaning.values) ops.push({ op: OP_USE, id });
		}
	}

	private mention(meaning: Meaning): void {
		const stamp = this.stamp;
		for (const id of meaning.values)
			if (this.mentionStamp[id] !== stamp) {
				this.mentionStamp[id] = stamp;
				this.mentions.push(id);
			}
		for (const id of meaning.objects)
			if (this.objectStamp[id] !== stamp) {
				this.objectStamp[id] = stamp;
				this.objects.push(id);
			}
		this.specials |= meaning.specials;
	}

	private write(id: number): void {
		if (this.writeStamp[id] === this.stamp) return;
		this.writeStamp[id] = this.stamp;
		this.writes.push(id);
	}

	private checkTemporary(name: string): void {
		const declaredIn = this.declared.get(name);
		if (declaredIn !== undefined && declaredIn !== this.block)
			decline(`temporary ${name} crosses blocks`);
	}

	private declareTemporary(name: string): void {
		if (this.scopeDepth > 0) return;
		const existing = this.declared.get(name);
		if (existing !== undefined && existing !== this.block)
			decline(`function-scope temporary ${name} declared twice`);
		this.declared.set(name, this.block);
	}
}

function hasKill(ops: ReadonlyArray<LiveOp>): boolean {
	for (const op of ops)
		if (op.op === OP_KILL || (op.op === OP_BRANCH && op.arms.some(hasKill))) return true;
	return false;
}

/** Appends ops as code that may or may not run: no kills, and exits that may continue. */
function flattenInto(into: Array<LiveOp>, ops: ReadonlyArray<LiveOp>): void {
	for (const op of ops) {
		switch (op.op) {
			case OP_KILL:
			case OP_RETURN:
				break;
			case OP_JUMP:
				into.push({ op: OP_EXIT, block: op.block });
				break;
			case OP_BRANCH:
				for (const arm of op.arms) flattenInto(into, arm);
				break;
			default:
				into.push(op);
		}
	}
}

function isOperandEnd(kind: number): boolean {
	return (
		kind === TOKEN_IDENTIFIER ||
		kind === TOKEN_NUMBER ||
		kind === TOKEN_STRING ||
		kind === TOKEN_RPAREN ||
		kind === TOKEN_RBRACKET
	);
}

function isLabelLine(line: string): boolean {
	if (line.length < 4 || line.charCodeAt(0) !== 76 /* L */ || !line.endsWith(":;"))
		return false;
	for (let at = 1; at < line.length - 2; at++) {
		const code = line.charCodeAt(at);
		if (code < 48 || code > 57) return false;
	}
	return true;
}

function scanBlocks(source: NativeSplitSource, frame: Frame): Graph {
	const { body, unitStarts } = source;
	const ranges: Array<ReadonlyArray<string>> = [];
	let blockStart = unitStarts[0]!;
	for (let unit = 1; unit < unitStarts.length; unit++) {
		const start = unitStarts[unit]!;
		if (start < body.length && start > blockStart && isLabelLine(body[start]!)) {
			ranges.push(body.slice(blockStart, start));
			blockStart = start;
		}
	}
	if (body.length > blockStart) ranges.push(body.slice(blockStart));
	if (ranges.length === 0) decline("empty body");
	ranges.push([`${source.fallOffLabel}:;`, ...source.fallOff]);
	const labels = new Map<string, number>();
	ranges.forEach((lines, index) => {
		if (!isLabelLine(lines[0]!)) {
			if (index !== 0) decline("unlabeled block");
			return;
		}
		const label = lines[0]!.slice(0, -2);
		if (labels.has(label)) decline(`duplicate label ${label}`);
		labels.set(label, index);
	});
	const parser = new BlockParser(frame, labels, new Map());
	const blocks = ranges.map((lines, index): Block => {
		const label = isLabelLine(lines[0]!) ? lines[0]!.slice(0, -2) : undefined;
		let size = 0;
		for (const line of lines) size += line.length + 1;
		return {
			...parser.parse(lines, label === undefined ? 0 : 1, index),
			lines,
			label,
			size,
		};
	});
	if (blocks[blocks.length - 1]!.fallsThrough) decline("fall-off code falls through");
	const throwExit =
		source.throwExit.length === 0
			? { objects: [], specials: 0, mentions: [] as ReadonlyArray<number> }
			: new BlockParser(frame, labels, new Map()).parse(source.throwExit, 1, -1);
	if (throwExit.mentions.length > 0) decline("throw exit reads frame values");
	const successors = blocks.map((block, index) => {
		if (block.usesThrowExit && source.throwExit.length === 0)
			decline("missing throw exit");
		const next = [...block.targets];
		if (block.fallsThrough && index + 1 < blocks.length && !next.includes(index + 1))
			next.push(index + 1);
		return next.sort((left, right) => left - right);
	});
	for (const id of frame.addressed) parser.addressed.add(id);
	return { blocks, successors, throwExit, addressed: parser.addressed };
}

interface PartFunction {
	readonly caller: number;
	/** Entry blocks in ascending order; empty for the parent. */
	readonly entries: Array<number>;
	/** Blocks this function renders itself, in ascending order. */
	readonly blocks: Array<number>;
	depth: number;
}

interface Partition {
	readonly owner: Int32Array;
	readonly reachable: Uint8Array;
	readonly functions: ReadonlyArray<PartFunction>;
	/** The part whose entry a block is, or -1. */
	readonly entryOf: Int32Array;
}

const STUB_CODE_UNITS = 256;

function partitionBlocks(
	graph: Graph,
	policy: NativeSplitPolicy,
	prologueCodeUnits: number,
): Partition {
	const { blocks, successors } = graph;
	const count = blocks.length;
	const budget = policy.partCodeUnits;
	// Smaller leaves cost their caller nearly as much code as they move.
	const leafMinimum = Math.max(1, Math.floor(budget / 32));
	const spineMinimum = Math.max(1, Math.floor(budget / 8));
	const reachable = new Uint8Array(count);
	const postorder: Array<number> = [];
	{
		const stack = [0];
		const cursor = new Int32Array(count);
		reachable[0] = 1;
		while (stack.length > 0) {
			const block = stack[stack.length - 1]!;
			const next = successors[block]!;
			if (cursor[block]! < next.length) {
				const successor = next[cursor[block]!++]!;
				if (reachable[successor] === 0) {
					reachable[successor] = 1;
					stack.push(successor);
				}
			} else {
				stack.pop();
				postorder.push(block);
			}
		}
	}
	const rpo = postorder.slice().reverse();
	const rpoIndex = new Int32Array(count).fill(-1);
	for (let index = 0; index < rpo.length; index++) rpoIndex[rpo[index]!] = index;
	const predecessors: Array<Array<number>> = Array.from({ length: count }, () => []);
	for (const block of rpo)
		for (const successor of successors[block]!) predecessors[successor]!.push(block);
	const idom = new Int32Array(count).fill(-1);
	idom[0] = 0;
	const intersect = (left: number, right: number): number => {
		while (left !== right) {
			while (rpoIndex[left]! > rpoIndex[right]!) left = idom[left]!;
			while (rpoIndex[right]! > rpoIndex[left]!) right = idom[right]!;
		}
		return left;
	};
	for (let changed = true; changed;) {
		changed = false;
		for (let index = 1; index < rpo.length; index++) {
			const block = rpo[index]!;
			let next = -1;
			for (const predecessor of predecessors[block]!)
				if (idom[predecessor] !== -1)
					next = next === -1 ? predecessor : intersect(predecessor, next);
			if (idom[block] !== next) {
				idom[block] = next;
				changed = true;
			}
		}
	}
	const children: Array<Array<number>> = Array.from({ length: count }, () => []);
	for (let index = 1; index < rpo.length; index++)
		children[idom[rpo[index]!]!]!.push(rpo[index]!);
	const enter = new Int32Array(count);
	const leave = new Int32Array(count);
	{
		let clock = 0;
		const stack: Array<number> = [0];
		const cursor = new Int32Array(count);
		enter[0] = clock++;
		while (stack.length > 0) {
			const block = stack[stack.length - 1]!;
			const kids = children[block]!;
			if (cursor[block]! < kids.length) {
				const child = kids[cursor[block]!++]!;
				enter[child] = clock++;
				stack.push(child);
			} else {
				leave[block] = clock;
				stack.pop();
			}
		}
	}
	const dominates = (ancestor: number, block: number) =>
		enter[ancestor]! <= enter[block]! && leave[block]! <= leave[ancestor]!;

	// Loop bodies that fit a part stay with their header.
	const pinned = new Uint8Array(count);
	{
		const latches = new Map<number, Array<number>>();
		for (const block of rpo)
			for (const successor of successors[block]!)
				if (dominates(successor, block)) {
					let list = latches.get(successor);
					if (list === undefined) latches.set(successor, (list = []));
					list.push(block);
				}
		const visited = new Int32Array(count).fill(-1);
		for (const [header, sources] of latches) {
			const body: Array<number> = [header];
			visited[header] = header;
			let size = blocks[header]!.size;
			const work = [...sources];
			let large = false;
			while (work.length > 0 && !large) {
				const block = work.pop()!;
				if (visited[block] === header || !dominates(header, block)) continue;
				visited[block] = header;
				body.push(block);
				size += blocks[block]!.size;
				if (size > budget) large = true;
				for (const predecessor of predecessors[block]!) work.push(predecessor);
			}
			if (large) continue;
			for (const block of body) if (block !== header) pinned[block] = 1;
		}
	}

	const subtree = new Float64Array(count);
	for (const block of postorder) {
		let size = blocks[block]!.size + (block === 0 ? prologueCodeUnits : 0);
		for (const child of children[block]!) size += subtree[child]!;
		subtree[block] = size;
	}
	const leaf = new Uint8Array(count);
	for (const block of rpo)
		if (
			block !== 0 &&
			pinned[block] === 0 &&
			subtree[block]! <= budget &&
			subtree[idom[block]!]! > budget &&
			subtree[block]! >= leafMinimum
		)
			leaf[block] = 1;
	// A spine longer than one part nests its tail in parts of its own.
	const spine = new Uint8Array(count);
	const pending = new Float64Array(count);
	for (const block of postorder) {
		let size = blocks[block]!.size + (block === 0 ? prologueCodeUnits : 0);
		const candidates: Array<number> = [];
		for (const child of children[block]!) {
			if (leaf[child] === 1) size += STUB_CODE_UNITS;
			else {
				size += pending[child]!;
				if (pinned[child] === 0 && pending[child]! >= spineMinimum)
					candidates.push(child);
			}
		}
		candidates.sort((left, right) => pending[right]! - pending[left]! || left - right);
		for (const child of candidates) {
			if (size <= budget) break;
			spine[child] = 1;
			size += STUB_CODE_UNITS - pending[child]!;
		}
		pending[block] = size;
	}

	const functions: Array<PartFunction> = [
		{ caller: -1, entries: [], blocks: [], depth: 0 },
	];
	const functionOfRoot = new Map<number, number>();
	// Leaf regions never contain spine roots or the immediate dominator of another leaf.
	const spineOwner = new Int32Array(count);
	for (const block of rpo) {
		if (block === 0 || spine[block] === 0) {
			spineOwner[block] = block === 0 ? 0 : spineOwner[idom[block]!]!;
			continue;
		}
		const caller = spineOwner[idom[block]!]!;
		const id = functions.length;
		functions.push({
			caller,
			entries: [block],
			blocks: [],
			depth: functions[caller]!.depth + 1,
		});
		functionOfRoot.set(block, id);
		spineOwner[block] = id;
	}
	// Leaves with one caller share parts, in block order, up to the budget.
	const leavesByCaller = new Map<number, Array<number>>();
	for (let block = 0; block < count; block++) {
		if (leaf[block] !== 1 || reachable[block] === 0) continue;
		const caller = spineOwner[idom[block]!]!;
		let list = leavesByCaller.get(caller);
		if (list === undefined) leavesByCaller.set(caller, (list = []));
		list.push(block);
	}
	for (const caller of [...leavesByCaller.keys()].sort((left, right) => left - right)) {
		let current = -1;
		let filled = 0;
		for (const root of leavesByCaller.get(caller)!) {
			const size = subtree[root]!;
			if (current === -1 || filled + size > budget) {
				current = functions.length;
				functions.push({
					caller,
					entries: [],
					blocks: [],
					depth: functions[caller]!.depth + 1,
				});
				filled = 0;
			}
			functions[current]!.entries.push(root);
			functionOfRoot.set(root, current);
			filled += size;
		}
	}
	const owner = new Int32Array(count).fill(-1);
	for (const block of rpo)
		owner[block] = block === 0 ? 0 : (functionOfRoot.get(block) ?? owner[idom[block]!]!);
	const entryOf = new Int32Array(count).fill(-1);
	for (const [root, id] of functionOfRoot) entryOf[root] = id;
	for (let block = 0; block < count; block++)
		if (reachable[block] === 1) functions[owner[block]!]!.blocks.push(block);
	return { owner, reachable, functions, entryOf };
}

/** Every cross-function edge must leave toward an ancestor or enter a part at an entry. */
function verifyPartition(graph: Graph, partition: Partition): void {
	const { owner, functions, entryOf, reachable } = partition;
	const isAncestor = (ancestor: number, id: number) => {
		for (let current = id; current !== -1; current = functions[current]!.caller)
			if (current === ancestor) return true;
		return false;
	};
	for (let block = 0; block < graph.blocks.length; block++) {
		if (reachable[block] === 0) continue;
		const from = owner[block]!;
		for (const target of graph.successors[block]!) {
			const to = owner[target]!;
			if (to === from) continue;
			const part = entryOf[target]!;
			const resolvedIn = part >= 0 ? functions[part]!.caller : to;
			if (!isAncestor(resolvedIn, from))
				decline(`edge ${block}->${target} crosses parts`);
		}
	}
}

type Bits = Uint32Array;

interface FunctionInterface {
	/** Candidate values each entry loads, by entry position; constants excluded. */
	readonly inputs: ReadonlyArray<Bits>;
	readonly exits: ReadonlyArray<number>;
	/** Exit targets reachable from each entry, by entry position. */
	readonly entryExits: ReadonlyArray<ReadonlySet<number>>;
	/** Values stored for the caller at each exit, by exit position. */
	readonly outputs: ReadonlyArray<Bits>;
	readonly mentioned: Bits;
	readonly objects: ReadonlySet<number>;
	readonly specials: number;
	readonly usesThrowExit: boolean;
	/** Labels this function places in its own text. */
	readonly local: ReadonlySet<number>;
}

interface Interfaces {
	readonly candidates: ReadonlyArray<number>;
	readonly constants: Bits;
	readonly functions: ReadonlyArray<FunctionInterface>;
}

function planInterfaces(graph: Graph, partition: Partition, frame: Frame): Interfaces {
	const { blocks, successors } = graph;
	const { owner, reachable, functions } = partition;
	const localCount = frame.locals.length;
	const candidateIndex = new Int32Array(localCount).fill(-1);
	const candidates: Array<number> = [];
	const written = new Uint8Array(localCount);
	for (let block = 0; block < blocks.length; block++) {
		if (reachable[block] === 0) continue;
		for (const id of blocks[block]!.writes) written[id] = 1;
		if (owner[block] === 0) continue;
		for (const id of blocks[block]!.mentions)
			if (candidateIndex[id] === -1 && !graph.addressed.has(id)) {
				candidateIndex[id] = candidates.length;
				candidates.push(id);
			}
	}
	const words = (candidates.length + 31) >>> 5;
	const constants = new Uint32Array(words);
	for (let index = 0; index < candidates.length; index++)
		if (written[candidates[index]!] === 0) constants[index >>> 5]! |= 1 << (index & 31);
	const programs = blocks.map((block) => compileOps(block.ops, candidateIndex));
	const liveIn = blocks.map(() => new Uint32Array(words));
	const order: Array<number> = [];
	{
		// Successors before predecessors converges quickest for a backward problem.
		const visited = new Uint8Array(blocks.length);
		const stack = [0];
		const cursor = new Int32Array(blocks.length);
		visited[0] = 1;
		while (stack.length > 0) {
			const block = stack[stack.length - 1]!;
			const next = successors[block]!;
			if (cursor[block]! < next.length) {
				const successor = next[cursor[block]!++]!;
				if (visited[successor] === 0) {
					visited[successor] = 1;
					stack.push(successor);
				}
			} else {
				stack.pop();
				order.push(block);
			}
		}
	}
	const live = new Uint32Array(words);
	for (let changed = true; changed;) {
		changed = false;
		for (const block of order) {
			if (blocks[block]!.fallsThrough) live.set(liveIn[block + 1]!);
			else live.fill(0);
			evaluate(programs[block]!, live, liveIn);
			const into = liveIn[block]!;
			for (let word = 0; word < words; word++)
				if (live[word] !== into[word]) {
					into.set(live);
					changed = true;
					break;
				}
		}
	}
	const byDepth = functions
		.map((_, id) => id)
		.sort(
			(left, right) => functions[right]!.depth - functions[left]!.depth || left - right,
		);
	const children: Array<Array<number>> = functions.map(() => []);
	for (let id = 1; id < functions.length; id++) children[functions[id]!.caller]!.push(id);
	const result: Array<FunctionInterface | undefined> = functions.map(() => undefined);
	for (const id of byDepth) {
		const fn = functions[id]!;
		const local = new Set<number>(fn.blocks);
		for (const child of children[id]!)
			for (const entry of functions[child]!.entries) local.add(entry);
		const mentioned = new Uint32Array(words);
		const mayWrite = new Uint32Array(words);
		const objects = new Set<number>();
		let specials = 0;
		let usesThrowExit = false;
		const exits = new Set<number>();
		for (const block of fn.blocks) {
			const facts = blocks[block]!;
			setBits(mentioned, facts.mentions, candidateIndex);
			setBits(mayWrite, facts.writes, candidateIndex);
			for (const object of facts.objects) objects.add(object);
			for (const id of facts.mentions) if (graph.addressed.has(id)) objects.add(id);
			specials |= facts.specials;
			if (facts.usesThrowExit) usesThrowExit = true;
			for (const target of successors[block]!) if (!local.has(target)) exits.add(target);
		}
		for (const child of children[id]!) {
			const childInterface = result[child]!;
			for (const bits of [...childInterface.inputs, ...childInterface.outputs])
				for (let word = 0; word < words; word++) mentioned[word]! |= bits[word]!;
			for (const bits of childInterface.outputs)
				for (let word = 0; word < words; word++) mayWrite[word]! |= bits[word]!;
			for (const target of childInterface.exits)
				if (!local.has(target)) exits.add(target);
		}
		if (usesThrowExit) {
			for (const object of graph.throwExit.objects) objects.add(object);
			specials |= graph.throwExit.specials;
		}
		const inputs = fn.entries.map((entry) => {
			const bits = new Uint32Array(words);
			const live = liveIn[entry]!;
			for (let word = 0; word < words; word++)
				bits[word] = live[word]! & mentioned[word]! & ~constants[word]!;
			return bits;
		});
		// A packed part lists only the exits each of its entries can reach.
		const childEntries = new Map<number, ReadonlySet<number>>();
		for (const child of children[id]!)
			functions[child]!.entries.forEach((entry, position) =>
				childEntries.set(entry, result[child]!.entryExits[position]!),
			);
		const entryExits = fn.entries.map((entry) => {
			const reached = new Set<number>();
			const seen = new Set<number>([entry]);
			const work = [entry];
			while (work.length > 0) {
				const block = work.pop()!;
				for (const target of childEntries.get(block) ?? successors[block]!) {
					if (!local.has(target)) reached.add(target);
					else if (!seen.has(target)) {
						seen.add(target);
						work.push(target);
					}
				}
			}
			return reached;
		});
		if (id !== 0) {
			exits.clear();
			for (const reached of entryExits) for (const target of reached) exits.add(target);
		}
		const exitList = [...exits].sort((left, right) => left - right);
		const outputs = exitList.map((target) => {
			const bits = new Uint32Array(words);
			const live = liveIn[target]!;
			for (let word = 0; word < words; word++) bits[word] = live[word]! & mayWrite[word]!;
			return bits;
		});
		if (id === 0 && exitList.length > 0) throw new Error("native split parent has exits");
		result[id] = {
			inputs,
			exits: exitList,
			entryExits,
			outputs,
			mentioned,
			objects,
			specials,
			usesThrowExit,
			local,
		};
	}
	return { candidates, constants, functions: result.map((value) => value!) };
}

/** Restates a block program over candidate indices, dropping other locals. */
function compileOps(
	ops: ReadonlyArray<LiveOp>,
	candidateIndex: Int32Array,
): Array<LiveOp> {
	const compiled: Array<LiveOp> = [];
	// Between kills and control transfers every op only adds live values, so repeats are idle.
	const used = new Set<number>();
	const exited = new Set<number>();
	const boundary = () => {
		used.clear();
		exited.clear();
	};
	for (const op of ops) {
		switch (op.op) {
			case OP_USE: {
				const index = candidateIndex[op.id]!;
				if (index < 0 || used.has(index)) break;
				used.add(index);
				compiled.push({ op: OP_USE, id: index });
				break;
			}
			case OP_KILL: {
				const index = candidateIndex[op.id]!;
				if (index < 0) break;
				boundary();
				compiled.push({ op: OP_KILL, id: index });
				break;
			}
			case OP_EXIT:
				if (exited.has(op.block)) break;
				exited.add(op.block);
				compiled.push(op);
				break;
			case OP_BRANCH:
				boundary();
				compiled.push({
					op: OP_BRANCH,
					arms: op.arms.map((arm) => compileOps(arm, candidateIndex)),
				});
				break;
			default:
				boundary();
				compiled.push(op);
		}
	}
	return compiled;
}

/** Rewrites `live` from the values live after the ops to those live before them. */
function evaluate(
	ops: ReadonlyArray<LiveOp>,
	live: Bits,
	liveIn: ReadonlyArray<Bits>,
): void {
	for (let index = ops.length - 1; index >= 0; index--) {
		const op = ops[index]!;
		switch (op.op) {
			case OP_USE:
				live[op.id >>> 5]! |= 1 << (op.id & 31);
				break;
			case OP_KILL:
				live[op.id >>> 5]! &= ~(1 << (op.id & 31));
				break;
			case OP_EXIT: {
				const target = liveIn[op.block]!;
				for (let word = 0; word < live.length; word++) live[word]! |= target[word]!;
				break;
			}
			case OP_JUMP:
				live.set(liveIn[op.block]!);
				break;
			case OP_RETURN:
				live.fill(0);
				break;
			case OP_BRANCH: {
				const after = live.slice();
				live.fill(0);
				for (const arm of op.arms) {
					const before = after.slice();
					evaluate(arm, before, liveIn);
					for (let word = 0; word < live.length; word++) live[word]! |= before[word]!;
				}
				break;
			}
		}
	}
}

function setBits(
	bits: Bits,
	ids: ReadonlyArray<number>,
	candidateIndex: Int32Array,
): void {
	for (const id of ids) {
		const index = candidateIndex[id]!;
		if (index >= 0) bits[index >>> 5]! |= 1 << (index & 31);
	}
}

function forEachBit(bits: Bits, visit: (index: number) => void): void {
	for (let word = 0; word < bits.length; word++) {
		let remaining = bits[word]!;
		while (remaining !== 0) {
			const low = remaining & -remaining;
			visit(word * 32 + (31 - Math.clz32(low)));
			remaining ^= low;
		}
	}
}

function hasBit(bits: Bits, index: number): boolean {
	return (bits[index >>> 5]! & (1 << (index & 31))) !== 0;
}

/** Rewrites each `return value;` of a part into a store of the result and exit code 0. */
function rewriteReturns(line: string, tokens: CTokenizer): string {
	if (!line.includes("return")) return line;
	tokens.reset(line);
	let output = "";
	let copied = 0;
	let previous = TOKEN_END;
	for (let kind = tokens.next(); kind !== TOKEN_END; kind = tokens.next()) {
		if (
			kind !== TOKEN_IDENTIFIER ||
			tokens.text !== "return" ||
			previous === TOKEN_DOT ||
			previous === TOKEN_ARROW
		) {
			previous = kind;
			continue;
		}
		const start = tokens.start;
		const expressionStart = tokens.end;
		let depth = 0;
		let end = -1;
		for (let next = tokens.next(); next !== TOKEN_END; next = tokens.next()) {
			if (next === TOKEN_LPAREN || next === TOKEN_LBRACKET || next === TOKEN_LBRACE)
				depth++;
			else if (next === TOKEN_RPAREN || next === TOKEN_RBRACKET || next === TOKEN_RBRACE)
				depth--;
			else if (next === TOKEN_SEMICOLON && depth === 0) {
				end = tokens.start;
				break;
			}
		}
		const expression = end < 0 ? "" : line.slice(expressionStart, end).trim();
		if (expression.length === 0) decline(`unsupported return: ${line}`);
		output += `${line.slice(copied, start)}{ __split_state->ret = (${expression}); return 0; }`;
		copied = end + 1;
		previous = TOKEN_SEMICOLON;
	}
	return output + line.slice(copied);
}

function renderSplit(
	source: NativeSplitSource,
	frame: Frame,
	graph: Graph,
	partition: Partition,
	interfaces: Interfaces,
): Array<string> {
	const { blocks } = graph;
	const { functions, reachable } = partition;
	const { candidates, constants } = interfaces;
	const symbol = source.symbol;
	const structName = `${symbol}_split`;
	const partSymbol = (id: number) => `${symbol}_part_${id}`;
	const labelOf = (block: number) => blocks[block]!.label!;
	const localOf = (index: number) => frame.locals[candidates[index]!]!;
	const tokens = new CTokenizer();

	const usedObjects = new Set<number>();
	let usedSpecials = 0;
	const fieldBits = new Uint32Array(constants.length);
	for (let id = 1; id < functions.length; id++) {
		const fn = interfaces.functions[id]!;
		for (const object of fn.objects) usedObjects.add(object);
		usedSpecials |= fn.specials;
		for (const bits of [...fn.inputs, ...fn.outputs])
			for (let word = 0; word < bits.length; word++) fieldBits[word]! |= bits[word]!;
		for (let word = 0; word < fieldBits.length; word++)
			fieldBits[word]! |= fn.mentioned[word]! & constants[word]!;
	}
	if ((usedSpecials & SPECIAL_GC_DESC) !== 0)
		decline("part references the frame descriptor");
	const objectList = [...usedObjects].sort((left, right) => left - right);

	const output: Array<string> = ["typedef struct {"];
	if ((usedSpecials & SPECIAL_GC_SLOTS) !== 0) output.push("    MalValue *gc_slots;");
	if ((usedSpecials & SPECIAL_GC_FRAME) !== 0) output.push("    MalRootFrame *gc_frame;");
	const pointerDeclaration = (local: FrameLocal, name: string, qualifier: string) =>
		local.array === undefined
			? `${local.declared} *${qualifier}${name}`
			: `${local.declared} (*${qualifier}${name})${local.array}`;
	for (const id of objectList) {
		const local = frame.locals[id]!;
		output.push(`    ${pointerDeclaration(local, `ref_${local.name}`, "")};`);
	}
	forEachBit(fieldBits, (index) => {
		const local = localOf(index);
		output.push(`    ${local.type} f_${local.name};`);
	});
	output.push(`    ${source.resultType} ret;`, `} ${structName};`);
	const signatureOf = (id: number) =>
		`static __attribute__((noinline)) u32 ${partSymbol(id)}(MalVm *vm, ${structName} *__split_state${functions[id]!.entries.length > 1 ? ", u32 __split_entry" : ""})`;
	for (let id = 1; id < functions.length; id++) output.push(`${signatureOf(id)};`);
	if (source.inactiveRows.length > 0) {
		const rowsName = `${symbol}_gc_inactive_rows`;
		output.push(
			source.inactiveRows[0]!.trim().replace("__gc_inactive_rows", rowsName),
			...source.inactiveRows.slice(1, -1),
			source.inactiveRows[source.inactiveRows.length - 1]!.trim(),
			`#define __gc_inactive_rows ${rowsName}`,
		);
	}

	const stub = (caller: number, child: number, position: number): Array<string> => {
		const callee = interfaces.functions[child]!;
		const entry = functions[child]!.entries[position]!;
		const access = caller === 0 ? "__split." : "__split_state->";
		const lines = [`${labelOf(entry)}:;`];
		forEachBit(callee.inputs[position]!, (index) => {
			const name = localOf(index).name;
			lines.push(`    ${access}f_${name} = ${name};`);
		});
		const argument = caller === 0 ? "&__split" : "__split_state";
		const entryArgument = functions[child]!.entries.length > 1 ? `, ${position}` : "";
		lines.push(
			`    switch (${partSymbol(child)}(vm, ${argument}${entryArgument})) {`,
			`    case 0: return ${caller === 0 ? "__split.ret" : "0"};`,
		);
		const reachableExits = callee.entryExits[position]!;
		callee.exits.forEach((target, exit) => {
			if (!reachableExits.has(target)) return;
			let loads = "";
			forEachBit(callee.outputs[exit]!, (index) => {
				const name = localOf(index).name;
				loads += `${name} = ${access}f_${name}; `;
			});
			lines.push(`    case ${exit + 1}: ${loads}goto ${labelOf(target)};`);
		});
		lines.push("    default: __builtin_unreachable();", "    }");
		return lines;
	};

	const renderItems = (id: number, lines: Array<string>, rewrite: boolean) => {
		const fn = functions[id]!;
		const items: Array<{ block: number; child: number; position: number }> =
			fn.blocks.map((block) => ({ block, child: -1, position: -1 }));
		for (let child = 1; child < functions.length; child++) {
			if (functions[child]!.caller !== id) continue;
			functions[child]!.entries.forEach((block, position) =>
				items.push({ block, child, position }),
			);
		}
		items.sort((left, right) => left.block - right.block);
		for (let index = 0; index < items.length; index++) {
			const item = items[index]!;
			if (item.child >= 0) {
				lines.push(...stub(id, item.child, item.position));
				continue;
			}
			const facts = blocks[item.block]!;
			for (const line of facts.lines)
				lines.push(rewrite ? rewriteReturns(line, tokens) : line);
			if (!facts.fallsThrough) continue;
			const next = item.block + 1;
			if (items[index + 1]?.block !== next) lines.push(`    goto ${labelOf(next)};`);
		}
	};

	output.push(source.signature, "#pragma STDC FP_CONTRACT OFF", ...source.prologue);
	output.push(...source.body.slice(0, source.unitStarts[0]));
	output.push(`    ${structName} __split;`);
	if ((usedSpecials & SPECIAL_GC_SLOTS) !== 0)
		output.push("    __split.gc_slots = __gc_slots;");
	if ((usedSpecials & SPECIAL_GC_FRAME) !== 0)
		output.push("    __split.gc_frame = &__gc_frame;");
	for (const id of objectList) {
		const name = frame.locals[id]!.name;
		output.push(`    __split.ref_${name} = &${name};`);
	}
	forEachBit(fieldBits, (index) => {
		if (!hasBit(constants, index)) return;
		const name = localOf(index).name;
		output.push(`    __split.f_${name} = ${name};`);
	});
	renderItems(0, output, false);
	const fallOff = blocks.length - 1;
	if (reachable[fallOff] === 0) output.push(...blocks[fallOff]!.lines);
	if (interfaces.functions[0]!.usesThrowExit) output.push(...source.throwExit);
	output.push("}");

	output.push("#define __gc_frame (*__split_gc_frame)");
	for (const id of objectList) {
		const name = frame.locals[id]!.name;
		output.push(`#define ${name} (*__split_ref_${name})`);
	}
	for (let id = 1; id < functions.length; id++) {
		const fn = functions[id]!;
		const plan = interfaces.functions[id]!;
		const lines = [`${signatureOf(id)} {`, "#pragma STDC FP_CONTRACT OFF"];
		if ((plan.specials & SPECIAL_GC_SLOTS) !== 0)
			lines.push("    MalValue *const __gc_slots = __split_state->gc_slots;");
		if ((plan.specials & SPECIAL_GC_FRAME) !== 0)
			lines.push("    MalRootFrame *const __split_gc_frame = __split_state->gc_frame;");
		for (const object of [...plan.objects].sort((left, right) => left - right)) {
			const local = frame.locals[object]!;
			lines.push(
				`    ${pointerDeclaration(local, `__split_ref_${local.name}`, "const ")} = __split_state->ref_${local.name};`,
			);
		}
		forEachBit(plan.mentioned, (index) => {
			const local = localOf(index);
			lines.push(
				hasBit(constants, index)
					? `    ${local.type} ${local.name} = __split_state->f_${local.name};`
					: `    ${local.type} ${local.name};`,
			);
		});
		const loads = (position: number) => {
			const statements: Array<string> = [];
			forEachBit(plan.inputs[position]!, (index) => {
				const name = localOf(index).name;
				statements.push(`${name} = __split_state->f_${name};`);
			});
			return statements;
		};
		if (fn.entries.length === 1) {
			for (const statement of loads(0)) lines.push(`    ${statement}`);
			const first = Math.min(
				fn.blocks[0] ?? Infinity,
				...functions.flatMap((other) => (other.caller === id ? other.entries : [])),
			);
			if (first !== fn.entries[0]) lines.push(`    goto ${labelOf(fn.entries[0]!)};`);
		} else {
			lines.push("    switch (__split_entry) {");
			fn.entries.forEach((entry, position) =>
				lines.push(
					`    case ${position}: ${loads(position).join(" ")} goto ${labelOf(entry)};`,
				),
			);
			lines.push("    default: __builtin_unreachable();", "    }");
		}
		renderItems(id, lines, true);
		if (plan.usesThrowExit)
			for (const line of source.throwExit) lines.push(rewriteReturns(line, tokens));
		plan.exits.forEach((target, exit) => {
			lines.push(`${labelOf(target)}:;`);
			forEachBit(plan.outputs[exit]!, (index) => {
				const name = localOf(index).name;
				lines.push(`    __split_state->f_${name} = ${name};`);
			});
			lines.push(`    return ${exit + 1};`);
		});
		lines.push("}");
		output.push(...lines);
	}
	for (const id of objectList) output.push(`#undef ${frame.locals[id]!.name}`);
	output.push("#undef __gc_frame");
	if (source.inactiveRows.length > 0) output.push("#undef __gc_inactive_rows");
	output.push(...source.trailer);
	return output;
}
