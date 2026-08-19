import { builtinOperationDescriptor } from "./builtin-registry.ts";
import {
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
} from "./compiler-facts.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "./compiler-instruction.ts";
import { coreOpcode, coreOpcodeRegistry, isCoreOpcode } from "./core-ir-opcodes.ts";
import { verifyCoreFunction, verifyCoreProgram } from "./core-ir-verifier.ts";
import { CoreFunctionBuilder, coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreHostInstallCandidate,
	CoreInstructionAttributes,
	CoreFunctionMetadata,
	CoreProgram,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import type { SemanticGraph, SemanticGraphFunction } from "./semantic-lowering.ts";

const structuralInstructionTypes: ReadonlySet<string> = new Set([
	"catch",
	"jump",
	"jumpIf",
	"return",
	"sourcePos",
	"throw",
	"tryBegin",
	"tryEnd",
]);

function isStructuralInstruction(type: string): boolean {
	return structuralInstructionTypes.has(type);
}

function destinationCount(instruction: CompilerInstruction): number {
	if (!("registers" in instruction)) return 0;
	if (isCoreOpcode(instruction.type)) return coreOpcode(instruction.type).outputs.minimum;
	if (isStructuralInstruction(instruction.type))
		return instruction.type === "catch" ? 1 : 0;
	throw new Error(`Unknown semantic-lowering instruction ${String(instruction.type)}`);
}

function definedRegisters(instruction: CompilerInstruction): Array<number> {
	if (!("registers" in instruction)) return [];
	return instruction.registers
		.slice(0, destinationCount(instruction))
		.filter((register) => register >= 0);
}

function usedRegisters(instruction: CompilerInstruction): Array<number> {
	if (!("registers" in instruction)) return [];
	return instruction.registers
		.slice(destinationCount(instruction))
		.filter((register) => register >= 0);
}

type ImportedRegisterRepresentation = "boxed" | "number" | "boolean";

const COMPARE_OPERATORS = new Set(["<", "<=", ">", ">=", "===", "==", "!==", "!="]);
const NUMBER_FROM_NUMBERS = new Set([
	"+",
	"-",
	"*",
	"/",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"%",
]);

function importedInstructionRepresentation(
	instruction: CompilerInstruction,
	representationOf: (register: number) => ImportedRegisterRepresentation | null,
): ImportedRegisterRepresentation | null {
	switch (instruction.type) {
		case "createNumber":
		case "createF64":
		case "mathUnaryNumber":
		case "mathBinaryNumber":
			return "number";
		case "createBoolean":
		case "typeofCompare":
			return "boolean";
		case "move":
			return representationOf(instruction.registers[1]);
		case "binary": {
			if (COMPARE_OPERATORS.has(instruction.operator)) return "boolean";
			if (!NUMBER_FROM_NUMBERS.has(instruction.operator)) return "boxed";
			const left = representationOf(instruction.registers[1]);
			const right = representationOf(instruction.registers[2]);
			return left === null || right === null
				? null
				: left === "number" && right === "number"
					? "number"
					: "boxed";
		}
		case "unary": {
			if (instruction.operator === "!") return "boolean";
			if (
				!["-", "+", "~", "tonumeric", "increment", "decrement"].includes(
					instruction.operator,
				)
			) {
				return "boxed";
			}
			const source = representationOf(instruction.registers[1]);
			return source === null ? null : source === "number" ? "number" : "boxed";
		}
		case "call": {
			const call = instruction.knownBuiltinCall;
			const descriptor =
				call === undefined ? undefined : builtinOperationDescriptor(call.operation);
			const arguments_ = instruction.registers.slice(3);
			if (
				call === undefined ||
				descriptor?.nativeNumberArity !== arguments_.length ||
				!knownBuiltinCallProves(call, call.operation) ||
				!compilerFactIsWorldInvariant(call.identity)
			) {
				return "boxed";
			}
			for (const argument of arguments_) {
				const representation = representationOf(argument);
				if (representation === null) return null;
				if (representation !== "number") return "boxed";
			}
			return "number";
		}
		default:
			return "boxed";
	}
}

function inferImportedRegisterRepresentations(
	fn: SemanticGraphFunction,
): Map<number, ImportedRegisterRepresentation> {
	const representations = new Map<number, ImportedRegisterRepresentation | null>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) continue;
			for (const register of instruction.registers) {
				if (register < 0 || representations.has(register)) continue;
				representations.set(register, register < fn.parameterCount ? "boxed" : null);
			}
		}
	}
	const representationOf = (register: number): ImportedRegisterRepresentation | null =>
		representations.has(register) ? representations.get(register)! : "boxed";
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const produced = importedInstructionRepresentation(instruction, representationOf);
				if (produced === null) continue;
				for (const destination of definedRegisters(instruction)) {
					if (destination < fn.parameterCount) continue;
					const current = representations.get(destination) ?? null;
					const joined =
						current === null ? produced : current === produced ? current : "boxed";
					if (joined !== current) {
						representations.set(destination, joined);
						changed = true;
					}
				}
			}
		}
	}
	return new Map(
		[...representations].map(([register, representation]) => [
			register,
			representation ?? "boxed",
		]),
	);
}

interface SemanticToken {
	readonly instruction: CompilerInstruction;
	readonly sourcePosition?: number;
}

type SegmentTerminator =
	| {
			readonly kind: "jump";
			readonly target: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<CompilerInstruction>;
	  }
	| {
			readonly kind: "branch";
			readonly condition: number;
			readonly consequent: number;
			readonly alternate: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<CompilerInstruction>;
	  }
	| {
			readonly kind: "return";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<CompilerInstruction>;
	  }
	| {
			readonly kind: "throw";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<CompilerInstruction>;
	  }
	| { readonly kind: "unreachable"; readonly sourcePosition?: number };

interface SemanticSegment {
	readonly id: number;
	readonly oldBlock: number;
	readonly handlerOldBlock: number | null;
	readonly tokens: Array<SemanticToken>;
	terminator?: SegmentTerminator;
	catchRegister?: number;
	readonly definitions: Set<number>;
	readonly usesBeforeDefinition: Set<number>;
	readonly liveIn: Set<number>;
	readonly ordinarySuccessors: Array<number>;
	exceptionalSuccessor?: number;
}

interface ConvertedCoreFunction {
	readonly core: CoreFunction;
}

export interface CoreConstructionOptions {
	/**
	 * Run the whole-program verifier after construction. Direct importer users get
	 * this by default; callers may omit it only when another phase owns the same
	 * verification boundary.
	 */
	readonly verify?: boolean;
}

function isControlInstruction(
	instruction: CompilerInstruction,
): instruction is Extract<
	CompilerInstruction,
	{ type: "jump" | "jumpIf" | "return" | "throw" }
> {
	return (
		instruction.type === "jump" ||
		instruction.type === "jumpIf" ||
		instruction.type === "return" ||
		instruction.type === "throw"
	);
}

function instructionMayThrow(instruction: CompilerInstruction): boolean {
	if (isCoreOpcode(instruction.type))
		return coreOpcode(instruction.type).effects.mayThrow;
	if (isStructuralInstruction(instruction.type)) {
		return instruction.type === "throw";
	}
	throw new Error(`Unknown Core construction instruction ${String(instruction.type)}`);
}

function cloneCoreAttribute(
	value: unknown,
	path: string,
	ancestors: ReadonlySet<object> = new Set(),
): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value !== "object") {
		throw new Error(`Unsupported Core attribute ${path}: ${typeof value}`);
	}
	if (ancestors.has(value)) throw new Error(`Cyclic Core attribute ${path}`);
	const nextAncestors = new Set(ancestors).add(value);
	if (Array.isArray(value)) {
		const arrayValue: ReadonlyArray<unknown> = value;
		const result = Array.from(arrayValue, (entry, index) =>
			cloneCoreAttribute(entry, `${path}[${index}]`, nextAncestors),
		);
		return result;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`Unsupported Core attribute object ${path}`);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = cloneCoreAttribute(entry, `${path}.${key}`, nextAncestors);
	}
	return result;
}

function registerPayload(
	instruction: CompilerInstruction,
	expandImmediateOperands = false,
): CoreInstructionAttributes {
	const attributes: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(instruction)) {
		if (
			key !== "type" &&
			key !== "registers" &&
			key !== "blocks" &&
			!(expandImmediateOperands && key === "immediateValues")
		) {
			attributes[key] = cloneCoreAttribute(value, `${instruction.type}.${key}`);
		}
	}
	return attributes as CoreInstructionAttributes;
}

function immediateOperand(
	instruction: CompilerInstruction,
	position: number,
): CompilerImmediateValue | undefined {
	return instruction.type === "call" || instruction.type === "construct"
		? instruction.immediateValues?.[position]
		: undefined;
}

function appendImmediateValue(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	value: CompilerImmediateValue,
	sourcePosition: number | undefined,
): CoreValueId {
	const specification = (() => {
		switch (value.kind) {
			case "undefined":
				return { opcode: "createUndefined", fields: {} } as const;
			case "null":
				return { opcode: "createNull", fields: {} } as const;
			case "boolean":
				return { opcode: "createBoolean", fields: { value: value.value } } as const;
			case "number":
				return { opcode: "createNumber", fields: { value: value.value } } as const;
			case "string":
				return {
					opcode: "createString",
					fields: { stringIndex: value.index },
				} as const;
		}
	})();
	const [output] = builder.appendInstruction(block, specification.opcode, [], {
		attributes: specification.fields,
		...(sourcePosition === undefined ? {} : { sourcePosition }),
	});
	return output!;
}

function coreInstructionInputs(
	instruction: CompilerInstruction,
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	sourcePosition: number | undefined,
	requireValue: (register: number, context: string) => CoreValueId,
): { readonly inputs: ReadonlyArray<CoreValueId>; readonly expandedImmediates: boolean } {
	if (!("registers" in instruction)) return { inputs: [], expandedImmediates: false };
	const inputs: Array<CoreValueId> = [];
	let expandedImmediates = false;
	const destinations = destinationCount(instruction);
	for (let position = destinations; position < instruction.registers.length; position++) {
		const register = instruction.registers[position]!;
		if (register >= 0) {
			inputs.push(requireValue(register, `Core construction ${instruction.type}`));
			continue;
		}
		const immediate = immediateOperand(instruction, position);
		if (immediate === undefined) continue;
		inputs.push(appendImmediateValue(builder, block, immediate, sourcePosition));
		expandedImmediates = true;
	}
	return { inputs, expandedImmediates };
}

function outputRepresentation(
	instruction: CompilerInstruction,
	index: number,
	registerRepresentations: ReadonlyMap<number, ImportedRegisterRepresentation>,
): CoreRepresentation {
	if (instruction.type === "createNumber" || instruction.type === "createF64")
		return "f64";
	if (instruction.type === "mathUnaryNumber" || instruction.type === "mathBinaryNumber") {
		return "f64";
	}
	if (
		index === 0 &&
		(instruction.type === "createBoolean" ||
			instruction.type === "guardFunctionIndex" ||
			instruction.type === "hasPrivate" ||
			instruction.type === "isEmpty" ||
			instruction.type === "typeofCompare")
	) {
		return "boolean";
	}
	const register = definedRegisters(instruction)[index];
	const inferred =
		register === undefined ? undefined : registerRepresentations.get(register);
	if (inferred === "number") return "f64";
	if (inferred === "boolean") return "boolean";
	return "boxed";
}

function coreRegisterRepresentation(
	registerRepresentations: ReadonlyMap<number, ImportedRegisterRepresentation>,
	register: number,
): CoreRepresentation {
	switch (registerRepresentations.get(register)) {
		case "number":
			return "f64";
		case "boolean":
			return "boolean";
		case "boxed":
		case undefined:
			return "boxed";
	}
}

function coreFunctionMetadata(fn: SemanticGraphFunction): CoreFunctionMetadata {
	const isClassConstructor = fn.classContext?.isConstructor ?? false;
	return {
		sourcePath: fn.semanticFile.path,
		sourceStrict: fn.semanticFile.strict,
		nameStringIndex: fn.nameStringIndex,
		length: fn.length,
		mappedArguments: fn.mappedArguments ?? false,
		mappedArgumentSlots: [...(fn.mappedArgumentSlots ?? [])],
		capturedCount: fn.nextCapturedIndex,
		strict: fn.strict ?? fn.semanticFile.strict,
		isClassConstructor,
		isDerivedConstructor:
			isClassConstructor && (fn.classContext?.isDerivedConstructor ?? false),
		hasPrototype: fn.hasPrototype ?? true,
	};
}

function splitSemanticGraphBlocks(fn: SemanticGraphFunction): {
	readonly segments: Array<SemanticSegment>;
	readonly segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>;
} {
	const segments: Array<SemanticSegment> = [];
	const segmentsByOldBlock: Array<Array<number>> = fn.blocks.map(() => []);
	const activeHandlers: Array<number> = [];
	const storedLocals = new Set<number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "storeLocal") storedLocals.add(instruction.index);
		}
	}
	const localRegisters = new Map<number, number>();
	let nextLocalRegister = fn.nextRegisterDestination;
	for (const local of [...storedLocals].sort((left, right) => left - right)) {
		localRegisters.set(local, nextLocalRegister++);
	}
	const normalizeLocal = (instruction: CompilerInstruction): CompilerInstruction => {
		if (instruction.type !== "loadLocal" && instruction.type !== "storeLocal") {
			return instruction;
		}
		if (instruction.type === "loadLocal" && !storedLocals.has(instruction.index)) {
			return { type: "createUndefined", registers: [instruction.registers[0]] };
		}
		const register = localRegisters.get(instruction.index)!;
		return instruction.type === "loadLocal"
			? { type: "move", registers: [instruction.registers[0], register] }
			: { type: "move", registers: [register, instruction.registers[0]] };
	};
	let sourcePosition: number | undefined;

	for (let oldBlock = 0; oldBlock < fn.blocks.length; oldBlock++) {
		let tokens: Array<SemanticToken> =
			oldBlock === 0
				? [...localRegisters.values()].map((register) => ({
						instruction: {
							type: "createUndefined" as const,
							registers: [register] as [number],
						},
					}))
				: [];
		let segmentHandler = activeHandlers.at(-1) ?? null;
		const flush = (force = false): void => {
			if (!force && tokens.length === 0) return;
			const id = segments.length;
			segments.push({
				id,
				oldBlock,
				handlerOldBlock: segmentHandler,
				tokens,
				definitions: new Set(),
				usesBeforeDefinition: new Set(),
				liveIn: new Set(),
				ordinarySuccessors: [],
			});
			segmentsByOldBlock[oldBlock]!.push(id);
			tokens = [];
			segmentHandler = activeHandlers.at(-1) ?? null;
		};

		for (const originalInstruction of fn.blocks[oldBlock]!.instructions) {
			const instruction = normalizeLocal(originalInstruction);
			if (instruction.type === "sourcePos") {
				sourcePosition = instruction.pos;
				continue;
			}
			if (instruction.type === "tryBegin") {
				flush();
				const handler = instruction.blocks[0];
				if (handler < 0 || handler >= fn.blocks.length) {
					throw new Error(`Unknown Core construction handler block ${handler}`);
				}
				activeHandlers.push(handler);
				segmentHandler = handler;
				continue;
			}
			if (instruction.type === "tryEnd") {
				flush();
				if (activeHandlers.pop() === undefined) {
					throw new Error("Unbalanced tryEnd in semantic graph");
				}
				segmentHandler = activeHandlers.at(-1) ?? null;
				continue;
			}

			const handler = activeHandlers.at(-1) ?? null;
			if (handler !== segmentHandler && tokens.length > 0) flush();
			segmentHandler = handler;
			const token: SemanticToken = {
				instruction,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			};
			const isolatedExceptionalInstruction =
				handler !== null &&
				(instruction.type === "throw" ||
					(!isControlInstruction(instruction) && instructionMayThrow(instruction)));
			if (isolatedExceptionalInstruction) flush();
			tokens.push(token);
			// Register conditional jumps can occur in the middle of a block: their
			// false edge continues at the next instruction. Core IR makes that edge
			// explicit, so every control instruction ends a segment. Instructions
			// following an unconditional control form a dead segment that the CFG
			// reachability pass removes.
			if (isolatedExceptionalInstruction || isControlInstruction(instruction)) {
				flush();
			}
		}
		flush(segmentsByOldBlock[oldBlock]!.length === 0);
	}
	if (activeHandlers.length > 0) {
		throw new Error("Unbalanced tryBegin in semantic graph");
	}
	return { segments, segmentsByOldBlock };
}

function firstSegment(
	segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>,
	oldBlock: number,
): number {
	const segment = segmentsByOldBlock[oldBlock]?.[0];
	if (segment === undefined) throw new Error(`Unknown template target block ${oldBlock}`);
	return segment;
}

function establishSegmentTerminators(
	fn: SemanticGraphFunction,
	segments: Array<SemanticSegment>,
	segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>,
): void {
	for (const segment of segments) {
		const controls = segment.tokens.filter(({ instruction }) =>
			isControlInstruction(instruction),
		);
		const firstControl = segment.tokens.findIndex(({ instruction }) =>
			isControlInstruction(instruction),
		);
		if (
			firstControl >= 0 &&
			segment.tokens
				.slice(firstControl)
				.some(({ instruction }) => !isControlInstruction(instruction))
		) {
			throw new Error(
				`Non-control instruction follows a terminator in template block ${segment.oldBlock}`,
			);
		}
		if (firstControl >= 0) segment.tokens.splice(firstControl);

		const siblings = segmentsByOldBlock[segment.oldBlock]!;
		const siblingIndex = siblings.indexOf(segment.id);
		const fallthrough =
			siblingIndex + 1 < siblings.length
				? siblings[siblingIndex + 1]!
				: segment.oldBlock + 1 < fn.blocks.length
					? firstSegment(segmentsByOldBlock, segment.oldBlock + 1)
					: undefined;
		const mapTarget = (target: number): number =>
			firstSegment(segmentsByOldBlock, target);

		if (controls.length === 0) {
			segment.terminator =
				fallthrough === undefined
					? { kind: "unreachable" }
					: { kind: "jump", target: fallthrough };
			continue;
		}
		if (controls.length === 1) {
			const { instruction, sourcePosition } = controls[0]!;
			switch (instruction.type) {
				case "jump":
					segment.terminator = {
						kind: "jump",
						target: mapTarget(instruction.blocks[0]),
						origins: [instruction],
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					};
					break;
				case "jumpIf":
					if (fallthrough === undefined) {
						throw new Error("Conditional template block has no fallthrough");
					}
					segment.terminator = {
						kind: "branch",
						condition: instruction.registers[0],
						consequent: mapTarget(instruction.blocks[0]),
						alternate: fallthrough,
						origins: [instruction],
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					};
					break;
				case "return":
				case "throw":
					segment.terminator = {
						kind: instruction.type,
						value: instruction.registers[0],
						origins: [instruction],
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					};
					break;
			}
			continue;
		}
		if (
			controls.length === 2 &&
			controls[0]!.instruction.type === "jumpIf" &&
			controls[1]!.instruction.type === "jump"
		) {
			const conditional = controls[0]!.instruction;
			const alternate = controls[1]!.instruction;
			segment.terminator = {
				kind: "branch",
				condition: conditional.registers[0],
				consequent: mapTarget(conditional.blocks[0]),
				alternate: mapTarget(alternate.blocks[0]),
				origins: [conditional, alternate],
				...(controls[0]!.sourcePosition === undefined
					? {}
					: { sourcePosition: controls[0]!.sourcePosition }),
			};
			continue;
		}
		throw new Error(
			`Unsupported template control sequence ${controls.map(({ instruction }) => instruction.type).join(", ")}`,
		);
	}
}

function pruneUnreachableSegments(
	segments: Array<SemanticSegment>,
): Array<SemanticSegment> {
	const reachable = new Set<number>();
	const pending = [0];
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (reachable.has(id)) continue;
		const segment = segments[id];
		if (segment === undefined) continue;
		reachable.add(id);
		pending.push(...segment.ordinarySuccessors);
		if (segment.exceptionalSuccessor !== undefined) {
			pending.push(segment.exceptionalSuccessor);
		}
	}
	if (reachable.size === segments.length) return segments;
	const oldToNew = new Map<number, number>();
	for (const segment of segments) {
		if (reachable.has(segment.id)) oldToNew.set(segment.id, oldToNew.size);
	}
	const rebase = (id: number): number => {
		const mapped = oldToNew.get(id);
		if (mapped === undefined)
			throw new Error(`Reachable Core segment targets dead segment ${id}`);
		return mapped;
	};
	const rebaseTerminator = (terminator: SegmentTerminator): SegmentTerminator => {
		switch (terminator.kind) {
			case "jump":
				return { ...terminator, target: rebase(terminator.target) };
			case "branch":
				return {
					...terminator,
					consequent: rebase(terminator.consequent),
					alternate: rebase(terminator.alternate),
				};
			case "return":
			case "throw":
			case "unreachable":
				return terminator;
		}
	};
	return segments
		.filter(({ id }) => reachable.has(id))
		.map((segment, id) => ({
			...segment,
			id,
			terminator: rebaseTerminator(segment.terminator!),
			ordinarySuccessors: segment.ordinarySuccessors.map(rebase),
			...(segment.exceptionalSuccessor === undefined
				? { exceptionalSuccessor: undefined }
				: { exceptionalSuccessor: rebase(segment.exceptionalSuccessor) }),
		}));
}

function terminatorRegisters(terminator: SegmentTerminator): ReadonlyArray<number> {
	switch (terminator.kind) {
		case "branch":
			return [terminator.condition];
		case "return":
		case "throw":
			return [terminator.value];
		case "jump":
		case "unreachable":
			return [];
	}
}

function analyzeSegments(
	segments: Array<SemanticSegment>,
	segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const handlerTargets = new Set<number>();
	for (const segment of segments) {
		for (const token of segment.tokens) {
			if (token.instruction.type === "catch") {
				if (segment.tokens[0] !== token) {
					throw new Error(
						`catch must be first in Core construction segment ${segment.id}`,
					);
				}
				segment.catchRegister = definedRegisters(token.instruction)[0];
				segment.tokens.shift();
				break;
			}
		}
		if (segment.handlerOldBlock !== null) {
			const target = firstSegment(segmentsByOldBlock, segment.handlerOldBlock);
			handlerTargets.add(target);
			if (
				segment.terminator?.kind === "throw" ||
				segment.tokens.some(({ instruction }) => instructionMayThrow(instruction))
			) {
				segment.exceptionalSuccessor = target;
			}
		}
		const terminator = segment.terminator;
		if (terminator === undefined)
			throw new Error(`Segment ${segment.id} has no terminator`);
		if (terminator.kind === "jump") segment.ordinarySuccessors.push(terminator.target);
		if (terminator.kind === "branch") {
			segment.ordinarySuccessors.push(terminator.consequent, terminator.alternate);
		}

		if (segment.catchRegister !== undefined)
			segment.definitions.add(segment.catchRegister);
		for (const { instruction } of segment.tokens) {
			for (const register of usedRegisters(instruction)) {
				if (!segment.definitions.has(register))
					segment.usesBeforeDefinition.add(register);
			}
			for (const register of definedRegisters(instruction))
				segment.definitions.add(register);
		}
		for (const register of terminatorRegisters(terminator)) {
			if (!segment.definitions.has(register)) segment.usesBeforeDefinition.add(register);
		}
	}
	for (const target of handlerTargets) {
		if (segments[target]!.catchRegister === undefined) {
			// Finally-only handlers do not consume the exception value, but Core IR
			// still gives the exceptional edge an explicit entry parameter.
			segments[target]!.catchRegister = -1;
		}
	}
	propagateSegmentLiveness(segments);
}

function propagateSegmentLiveness(segments: Array<SemanticSegment>): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = segments.length - 1; index >= 0; index--) {
			const segment = segments[index]!;
			const next = new Set(segment.usesBeforeDefinition);
			for (const successor of segment.ordinarySuccessors) {
				for (const register of segments[successor]!.liveIn) {
					if (!segment.definitions.has(register)) next.add(register);
				}
			}
			if (segment.exceptionalSuccessor !== undefined) {
				for (const register of segments[segment.exceptionalSuccessor]!.liveIn) {
					// A throwing instruction's outputs do not exist on its exceptional edge.
					next.add(register);
				}
			}
			if (
				next.size !== segment.liveIn.size ||
				[...next].some((register) => !segment.liveIn.has(register))
			) {
				segment.liveIn.clear();
				for (const register of next) segment.liveIn.add(register);
				changed = true;
			}
		}
	}
}

/**
 * The template VM initializes non-parameter registers to undefined. Most semantic
 * The frontend graph defines every virtual register before use, but control joins can
 * deliberately rely on that frame invariant. Make those values explicit before
 * constructing SSA so they cannot masquerade as ABI inputs.
 */
function initializeImplicitEntryValues(
	segments: Array<SemanticSegment>,
	parameterCount: number,
): void {
	const entry = segments[0]!;
	const registers = [...entry.liveIn]
		.filter((register) => register >= parameterCount)
		.sort((left, right) => left - right);
	if (registers.length === 0) return;
	entry.tokens.unshift(
		...registers.map((register) => ({
			instruction: {
				type: "createUndefined" as const,
				registers: [register] as [number],
			},
		})),
	);
	for (const register of registers) {
		entry.definitions.add(register);
		entry.usesBeforeDefinition.delete(register);
	}
	for (const segment of segments) segment.liveIn.clear();
	propagateSegmentLiveness(segments);
}

function sortedRegisters(registers: ReadonlySet<number>): Array<number> {
	return [...registers].sort((left, right) => left - right);
}

/**
 * The optimized graph is overwhelmingly made of closed, single-block
 * functions. Import those without allocating the generic segmentation and
 * liveness machinery; fall back as soon as control or an implicit live-in makes
 * the straight-line proof inapplicable.
 */
function convertStraightLineFunction(
	fn: SemanticGraphFunction,
	verify: boolean,
	registerRepresentations: ReadonlyMap<number, ImportedRegisterRepresentation>,
): ConvertedCoreFunction | undefined {
	if (fn.blocks.length !== 1) return undefined;
	const executable = fn.blocks[0]!.instructions.filter(
		(instruction) => instruction.type !== "sourcePos",
	);
	if (
		executable.some(
			(instruction) =>
				instruction.type === "loadLocal" || instruction.type === "storeLocal",
		)
	) {
		return undefined;
	}
	const terminator = executable.at(-1);
	if (terminator?.type !== "return" && terminator?.type !== "throw") {
		return undefined;
	}
	if (
		executable
			.slice(0, -1)
			.some(
				(instruction) =>
					isControlInstruction(instruction) ||
					instruction.type === "tryBegin" ||
					instruction.type === "tryEnd" ||
					instruction.type === "catch",
			)
	) {
		return undefined;
	}

	const definitions = new Set<number>(
		Array.from({ length: fn.parameterCount }, (_, index) => index),
	);
	for (const instruction of executable) {
		if (usedRegisters(instruction).some((register) => !definitions.has(register))) {
			return undefined;
		}
		for (const register of definedRegisters(instruction)) definitions.add(register);
	}

	const builder = new CoreFunctionBuilder(fn.functionIndex, coreOpcodeRegistry, {
		isGenerator: fn.isGenerator === true,
		isAsync: fn.isAsync === true,
		parameterCount: fn.parameterCount,
		metadata: coreFunctionMetadata(fn),
	});
	const block = builder.createBlock(
		Array.from({ length: fn.parameterCount }, () => ({
			representation: "boxed" as const,
		})),
	);
	const values = new Map<number, CoreValueId>(
		builder
			.block(block)
			.parameters.slice(0, fn.parameterCount)
			.map(({ value }, index) => [index, value]),
	);
	let sourcePosition: number | undefined;
	for (const instruction of fn.blocks[0]!.instructions) {
		if (instruction.type === "sourcePos") {
			sourcePosition = instruction.pos;
			continue;
		}
		if (instruction === terminator) {
			builder.setTerminator(block, {
				kind: instruction.type,
				value: values.get(instruction.registers[0])!,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			});
			continue;
		}
		const { inputs, expandedImmediates } = coreInstructionInputs(
			instruction,
			builder,
			block,
			sourcePosition,
			(register, context) => {
				const value = values.get(register);
				if (value === undefined) {
					throw new Error(`${context} reads uninitialized template register ${register}`);
				}
				return value;
			},
		);
		const destinations = definedRegisters(instruction);
		const attributes = registerPayload(instruction, expandedImmediates);
		const outputs = builder.appendInstruction(block, instruction.type, inputs, {
			outputCount: destinations.length,
			outputRepresentations: destinations.map((_, index) =>
				outputRepresentation(instruction, index, registerRepresentations),
			),
			attributes,
			...(sourcePosition === undefined ? {} : { sourcePosition }),
		});
		for (const [index, register] of destinations.entries()) {
			values.set(register, outputs[index]!);
		}
	}
	const finished = builder.finish(block);
	const graph = fn.bodyEntryBlock === 0 ? { ...finished, bodyEntry: block } : finished;
	const core = { ...graph, regions: [] };
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
	};
}

function convertFunction(
	fn: SemanticGraphFunction,
	verify: boolean,
): ConvertedCoreFunction {
	const registerRepresentations = inferImportedRegisterRepresentations(fn);
	const straightLine = convertStraightLineFunction(fn, verify, registerRepresentations);
	if (straightLine !== undefined) return straightLine;
	const { segments: splitSegments, segmentsByOldBlock } = splitSemanticGraphBlocks(fn);
	establishSegmentTerminators(fn, splitSegments, segmentsByOldBlock);
	analyzeSegments(splitSegments, segmentsByOldBlock);
	initializeImplicitEntryValues(splitSegments, fn.parameterCount);
	const segments = pruneUnreachableSegments(splitSegments);
	for (let parameter = 0; parameter < fn.parameterCount; parameter++) {
		segments[0]!.liveIn.add(parameter);
	}

	const builder = new CoreFunctionBuilder(fn.functionIndex, coreOpcodeRegistry, {
		isGenerator: fn.isGenerator === true,
		isAsync: fn.isAsync === true,
		parameterCount: fn.parameterCount,
		metadata: coreFunctionMetadata(fn),
	});
	const coreBlocks: Array<CoreBlockId> = [];
	const blockRegisters: Array<Array<number>> = [];
	for (const segment of segments) {
		const liveIn = sortedRegisters(segment.liveIn);
		blockRegisters.push(liveIn);
		const block = builder.createBlock([
			...(segment.catchRegister === undefined
				? []
				: [{ role: "exception" as const, representation: "boxed" as const }]),
			...liveIn.map((register) => ({
				representation: coreRegisterRepresentation(registerRepresentations, register),
			})),
		]);
		coreBlocks.push(block);
	}

	const requireValue = (
		values: ReadonlyMap<number, CoreValueId>,
		register: number,
		context: string,
	): CoreValueId => {
		const value = values.get(register);
		if (value === undefined) {
			throw new Error(`${context} reads uninitialized template register ${register}`);
		}
		return value;
	};

	for (const segment of segments) {
		const block = coreBlocks[segment.id]!;
		const parameters = builder.block(block).parameters;
		const values = new Map<number, CoreValueId>();
		let parameterIndex = 0;
		if (segment.catchRegister !== undefined) {
			const exception = parameters[parameterIndex++]!.value;
			if (segment.catchRegister >= 0) values.set(segment.catchRegister, exception);
		}
		for (const register of blockRegisters[segment.id]!) {
			values.set(register, parameters[parameterIndex++]!.value);
		}
		const entryValues = new Map(values);

		for (const { instruction, sourcePosition } of segment.tokens) {
			const { inputs, expandedImmediates } = coreInstructionInputs(
				instruction,
				builder,
				block,
				sourcePosition,
				(register, context) => requireValue(values, register, context),
			);
			const destinations = definedRegisters(instruction);
			const attributes = registerPayload(instruction, expandedImmediates);
			const outputs = builder.appendInstruction(block, instruction.type, inputs, {
				outputCount: destinations.length,
				outputRepresentations: destinations.map((_, index) =>
					outputRepresentation(instruction, index, registerRepresentations),
				),
				attributes,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			});
			for (const [index, register] of destinations.entries()) {
				values.set(register, outputs[index]!);
			}
		}

		const edge = (target: number, sourceValues = values): CoreEdge => ({
			block: coreBlocks[target]!,
			arguments: blockRegisters[target]!.map((register) =>
				requireValue(sourceValues, register, `Core edge b${segment.id} -> b${target}`),
			),
		});
		const registerTerminator = segment.terminator!;
		let terminator: CoreTerminatorInput;
		switch (registerTerminator.kind) {
			case "jump":
				terminator = {
					kind: "jump",
					edge: edge(registerTerminator.target),
					...(registerTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: registerTerminator.sourcePosition }),
				};
				break;
			case "branch":
				terminator = {
					kind: "branch",
					condition: requireValue(values, registerTerminator.condition, "Core branch"),
					consequent: edge(registerTerminator.consequent),
					alternate: edge(registerTerminator.alternate),
					...(registerTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: registerTerminator.sourcePosition }),
				};
				break;
			case "return":
			case "throw":
				terminator = {
					kind: registerTerminator.kind,
					value: requireValue(
						values,
						registerTerminator.value,
						`Core ${registerTerminator.kind}`,
					),
					...(registerTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: registerTerminator.sourcePosition }),
				};
				break;
			case "unreachable":
				terminator = { kind: "unreachable" };
				break;
		}
		builder.setTerminator(block, terminator);
		if (segment.exceptionalSuccessor !== undefined) {
			builder.setHandler(
				block,
				coreBlocks[segment.exceptionalSuccessor]!,
				edge(segment.exceptionalSuccessor, entryValues).arguments,
			);
		}
	}

	const bodyEntrySegment =
		fn.bodyEntryBlock === undefined
			? undefined
			: segments.find(({ oldBlock }) => oldBlock === fn.bodyEntryBlock);
	const finished = builder.finish(coreBlocks[0]!);
	const graph =
		bodyEntrySegment === undefined
			? finished
			: { ...finished, bodyEntry: coreBlockId(bodyEntrySegment.id) };
	const core = { ...graph, regions: [] };
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
	};
}

/** Construct canonical block-parameter SSA from the ephemeral semantic graph. */
export function buildCoreProgramFromSemanticGraph(
	program: SemanticGraph,
	options: CoreConstructionOptions = {},
): CoreProgram {
	const verify = options.verify ?? true;
	const converted = program.functions.map((fn) => convertFunction(fn, false));
	const core: CoreProgram = {
		functions: converted.map(({ core }) => core),
		stringConstants: program.stringConstants.map((units) => [...units]),
		bigintConstants: [...program.bigintConstants],
		literalTemplateData: [...program.literalTemplateData],
		sourcePositions: program.sourcePositions.map((position) => ({ ...position })),
		globalCount: program.nextGlobalIndex,
		compilation: {
			semantic: program.semantic,
			facts: program.facts,
			...(program.optimizationDecisions === undefined
				? {}
				: { optimizationDecisions: [...program.optimizationDecisions] }),
			...(program.optimizationTrace === undefined
				? {}
				: { optimizationTrace: [...program.optimizationTrace] }),
			cjsModuleFunctionIndices: [...program.cjsWrapperFunctionIndex],
			hostInstallCandidates: coreHostInstallCandidates(program),
			retainedHostInstallers: [program.hostProcess, program.hostBuffer]
				.flatMap((host) => (host?.retained === true ? [host.installer] : []))
				.filter(
					(installer, index, installers) => installers.indexOf(installer) === index,
				),
		},
	};
	if (verify) verifyCoreProgram(core, coreOpcodeRegistry);
	return core;
}

function coreHostInstallCandidates(
	program: SemanticGraph,
): Array<CoreHostInstallCandidate> {
	const candidates = new Map<
		string,
		Array<{ readonly name: string; readonly slot: number }>
	>();
	for (const hostModule of program.hostModules) {
		const entries = candidates.get(hostModule.installer) ?? [];
		for (const { name, binding } of hostModule.exports) {
			const location = program.bindingToStorage.get(binding);
			if (location?.type === "global") entries.push({ name, slot: location.index });
		}
		if (entries.length > 0) candidates.set(hostModule.installer, entries);
	}
	return [...candidates].map(([installer, entries]) => ({
		installer,
		exports: entries,
	}));
}
