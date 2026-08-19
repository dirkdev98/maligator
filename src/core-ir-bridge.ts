import { coreOpcode, coreOpcodeRegistry, isCoreOpcode } from "./core-ir-opcodes.ts";
import { verifyCoreFunction, verifyCoreProgram } from "./core-ir-verifier.ts";
import { CoreFunctionBuilder, coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreInstructionId,
	CoreInstructionAttributes,
	CoreFunctionMetadata,
	CoreProgram,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import {
	destinationCount,
	definedRegisters,
	usedRegisters,
} from "./ir-register-index.ts";
import { isIrStructuralInstructionType } from "./ir-structure.ts";
import type {
	IntermediateProgram,
	IRBlock,
	IRFunction,
	IRImmediateValue,
	IRInstruction,
} from "./ir.ts";

interface LegacyInstructionLowering {
	readonly registerLayout?: ReadonlyArray<
		| { readonly kind: "output"; readonly index: number }
		| { readonly kind: "input"; readonly index: number }
		| { readonly kind: "literal"; readonly value: number }
	>;
	readonly attributes: CoreInstructionAttributes;
}

interface LegacyToken {
	readonly instruction: IRInstruction;
	readonly sourcePosition?: number;
}

type SegmentTerminator =
	| {
			readonly kind: "jump";
			readonly target: number;
			readonly sourcePosition?: number;
			readonly origin?: IRInstruction;
	  }
	| {
			readonly kind: "branch";
			readonly condition: number;
			readonly consequent: number;
			readonly alternate: number;
			readonly sourcePosition?: number;
			readonly origin?: IRInstruction;
	  }
	| {
			readonly kind: "return";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origin?: IRInstruction;
	  }
	| {
			readonly kind: "throw";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origin?: IRInstruction;
	  }
	| { readonly kind: "unreachable"; readonly sourcePosition?: number };

interface LegacySegment {
	readonly id: number;
	readonly oldBlock: number;
	readonly handlerOldBlock: number | null;
	readonly tokens: Array<LegacyToken>;
	terminator?: SegmentTerminator;
	catchRegister?: number;
	readonly definitions: Set<number>;
	readonly usesBeforeDefinition: Set<number>;
	readonly liveIn: Set<number>;
	readonly ordinarySuccessors: Array<number>;
	exceptionalSuccessor?: number;
}

export interface CoreFunctionLowering {
	readonly legacy: IRFunction;
	readonly instructionOrigins: ReadonlyMap<CoreInstructionId, IRInstruction>;
	readonly instructionLowering: ReadonlyMap<
		CoreInstructionId,
		LegacyInstructionLowering
	>;
	readonly legacyRegisters: ReadonlyMap<CoreValueId, number>;
	readonly legacyBlockByCoreBlock: ReadonlyMap<CoreBlockId, number>;
}

export interface CoreProgramBridge {
	readonly source: IntermediateProgram;
	readonly core: CoreProgram;
	readonly lowering: ReadonlyArray<CoreFunctionLowering>;
}

interface ConvertedCoreFunction extends CoreFunctionLowering {
	readonly core: CoreFunction;
}

export interface CoreProgramConstructionOptions {
	/**
	 * Run the whole-program verifier after construction. Direct bridge users get
	 * this by default; callers may omit it only when another phase owns the same
	 * verification boundary.
	 */
	readonly verify?: boolean;
	/** Retain origin/register maps needed to lower this Core program back to VM IR. */
	readonly retainLoweringMetadata?: boolean;
}

function isControlInstruction(
	instruction: IRInstruction,
): instruction is Extract<
	IRInstruction,
	{ type: "jump" | "jumpIf" | "return" | "throw" }
> {
	return (
		instruction.type === "jump" ||
		instruction.type === "jumpIf" ||
		instruction.type === "return" ||
		instruction.type === "throw"
	);
}

function instructionMayThrow(instruction: IRInstruction): boolean {
	if (isCoreOpcode(instruction.type)) return coreOpcode(instruction.type).effects.mayThrow;
	if (isIrStructuralInstructionType(instruction.type)) {
		return instruction.type === "throw";
	}
	throw new Error(`Unknown legacy IR instruction ${String(instruction.type)}`);
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

function legacyPayload(
	instruction: IRInstruction,
	retainLoweringMetadata = true,
	expandImmediateOperands = false,
): LegacyInstructionLowering {
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
	if (!retainLoweringMetadata || !("registers" in instruction)) {
		return { attributes: attributes as CoreInstructionAttributes };
	}
	let outputIndex = 0;
	let inputIndex = 0;
	const destinations = destinationCount(instruction);
	const registerLayout = instruction.registers.map((register, position) => {
		if (position < destinations) {
			return { kind: "output" as const, index: outputIndex++ };
		}
		if (register < 0 && !expandImmediateOperands) {
			return { kind: "literal" as const, value: register };
		}
		return { kind: "input" as const, index: inputIndex++ };
	});
	return { registerLayout, attributes: attributes as CoreInstructionAttributes };
}

function immediateOperand(
	instruction: IRInstruction,
	position: number,
): IRImmediateValue | undefined {
	return instruction.type === "call" || instruction.type === "construct"
		? instruction.immediateValues?.[position]
		: undefined;
}

function appendImmediateValue(
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	value: IRImmediateValue,
	retainLoweringMetadata: boolean,
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
	instruction: IRInstruction,
	builder: CoreFunctionBuilder,
	block: CoreBlockId,
	retainLoweringMetadata: boolean,
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
			inputs.push(requireValue(register, `Core bridge ${instruction.type}`));
			continue;
		}
		const immediate = immediateOperand(instruction, position);
		if (immediate === undefined) continue;
		inputs.push(
			appendImmediateValue(
				builder,
				block,
				immediate,
				retainLoweringMetadata,
				sourcePosition,
			),
		);
		expandedImmediates = true;
	}
	return { inputs, expandedImmediates };
}

function outputRepresentation(
	instruction: IRInstruction,
	index: number,
): CoreRepresentation {
	if (instruction.type === "createF64") return "f64";
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
	return "boxed";
}

function coreFunctionMetadata(fn: IRFunction): CoreFunctionMetadata {
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

function splitLegacyBlocks(fn: IRFunction): {
	readonly segments: Array<LegacySegment>;
	readonly segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>;
} {
	const segments: Array<LegacySegment> = [];
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
	const normalizeLocal = (instruction: IRInstruction): IRInstruction => {
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
		let tokens: Array<LegacyToken> =
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
					throw new Error(`Unknown Core bridge handler block ${handler}`);
				}
				activeHandlers.push(handler);
				segmentHandler = handler;
				continue;
			}
			if (instruction.type === "tryEnd") {
				flush();
				if (activeHandlers.pop() === undefined) {
					throw new Error("Unbalanced tryEnd in Core bridge input");
				}
				segmentHandler = activeHandlers.at(-1) ?? null;
				continue;
			}

			const handler = activeHandlers.at(-1) ?? null;
			if (handler !== segmentHandler && tokens.length > 0) flush();
			segmentHandler = handler;
			const token: LegacyToken = {
				instruction,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			};
			const isolatedExceptionalInstruction =
				handler !== null &&
				(instruction.type === "throw" ||
					(!isControlInstruction(instruction) && instructionMayThrow(instruction)));
			if (isolatedExceptionalInstruction) flush();
			tokens.push(token);
			// Legacy conditional jumps can occur in the middle of a block: their
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
		throw new Error("Unbalanced tryBegin in Core bridge input");
	}
	return { segments, segmentsByOldBlock };
}

function firstSegment(
	segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>,
	oldBlock: number,
): number {
	const segment = segmentsByOldBlock[oldBlock]?.[0];
	if (segment === undefined) throw new Error(`Unknown legacy target block ${oldBlock}`);
	return segment;
}

function establishSegmentTerminators(
	fn: IRFunction,
	segments: Array<LegacySegment>,
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
				`Non-control instruction follows a terminator in legacy block ${segment.oldBlock}`,
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
						origin: instruction,
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					};
					break;
				case "jumpIf":
					if (fallthrough === undefined) {
						throw new Error("Conditional legacy block has no fallthrough");
					}
					segment.terminator = {
						kind: "branch",
						condition: instruction.registers[0],
						consequent: mapTarget(instruction.blocks[0]),
						alternate: fallthrough,
						origin: instruction,
						...(sourcePosition === undefined ? {} : { sourcePosition }),
					};
					break;
				case "return":
				case "throw":
					segment.terminator = {
						kind: instruction.type,
						value: instruction.registers[0],
						origin: instruction,
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
				origin: conditional,
				...(controls[0]!.sourcePosition === undefined
					? {}
					: { sourcePosition: controls[0]!.sourcePosition }),
			};
			continue;
		}
		throw new Error(
			`Unsupported legacy control sequence ${controls.map(({ instruction }) => instruction.type).join(", ")}`,
		);
	}
}

function pruneUnreachableSegments(segments: Array<LegacySegment>): Array<LegacySegment> {
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
	segments: Array<LegacySegment>,
	segmentsByOldBlock: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const handlerTargets = new Set<number>();
	for (const segment of segments) {
		for (const token of segment.tokens) {
			if (token.instruction.type === "catch") {
				if (segment.tokens[0] !== token) {
					throw new Error(`catch must be first in Core bridge segment ${segment.id}`);
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

function propagateSegmentLiveness(segments: Array<LegacySegment>): void {
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
 * The legacy VM initializes non-parameter registers to undefined. Most semantic
 * IR defines every virtual register before use, but completion/control joins can
 * deliberately rely on that frame invariant. Make those values explicit before
 * constructing SSA so they cannot masquerade as ABI inputs.
 */
function initializeImplicitEntryValues(
	segments: Array<LegacySegment>,
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
	fn: IRFunction,
	verify: boolean,
	retainLoweringMetadata: boolean,
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
		Array.from({ length: fn.parameterCount }, () => ({ representation: "boxed" as const })),
	);
	const values = new Map<number, CoreValueId>(
		builder
			.block(block)
			.parameters.slice(0, fn.parameterCount)
			.map(({ value }, index) => [index, value]),
	);
	const instructionOrigins = new Map<CoreInstructionId, IRInstruction>();
	const instructionLowering = new Map<CoreInstructionId, LegacyInstructionLowering>();
	const legacyRegisters = new Map<CoreValueId, number>();
	if (retainLoweringMetadata) {
		for (const [register, value] of values) legacyRegisters.set(value, register);
	}
	let sourcePosition: number | undefined;
	for (const instruction of fn.blocks[0]!.instructions) {
		if (instruction.type === "sourcePos") {
			sourcePosition = instruction.pos;
			continue;
		}
		if (instruction === terminator) {
			const id = builder.setTerminator(block, {
				kind: instruction.type,
				value: values.get(instruction.registers[0])!,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			});
			if (retainLoweringMetadata) instructionOrigins.set(id, instruction);
			continue;
		}
		const { inputs, expandedImmediates } = coreInstructionInputs(
			instruction,
			builder,
			block,
			retainLoweringMetadata,
			sourcePosition,
			(register, context) => {
				const value = values.get(register);
				if (value === undefined) {
					throw new Error(`${context} reads uninitialized legacy register ${register}`);
				}
				return value;
			},
		);
		const destinations = definedRegisters(instruction);
		const lowering = legacyPayload(
			instruction,
			retainLoweringMetadata,
			expandedImmediates,
		);
		const outputs = builder.appendInstruction(block, instruction.type, inputs, {
			outputCount: destinations.length,
			outputRepresentations: destinations.map((_, index) =>
				outputRepresentation(instruction, index),
			),
			attributes: lowering.attributes,
			...(sourcePosition === undefined ? {} : { sourcePosition }),
		});
		const appended = builder.block(block).instructions.at(-1)!;
		if (retainLoweringMetadata) {
			instructionOrigins.set(appended.id, instruction);
			instructionLowering.set(appended.id, lowering);
		}
		for (const [index, register] of destinations.entries()) {
			values.set(register, outputs[index]!);
			if (retainLoweringMetadata) legacyRegisters.set(outputs[index]!, register);
		}
	}
	const finished = builder.finish(block);
	const core =
		fn.bodyEntryBlock === 0
			? { ...finished, bodyEntry: block }
			: finished;
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
		legacy: fn,
		instructionOrigins,
		instructionLowering,
		legacyRegisters,
		legacyBlockByCoreBlock: retainLoweringMetadata ? new Map([[block, 0]]) : new Map(),
	};
}

function convertFunction(
	fn: IRFunction,
	verify: boolean,
	retainLoweringMetadata: boolean,
): ConvertedCoreFunction {
	const straightLine = convertStraightLineFunction(fn, verify, retainLoweringMetadata);
	if (straightLine !== undefined) return straightLine;
	const { segments: splitSegments, segmentsByOldBlock } = splitLegacyBlocks(fn);
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
	const instructionOrigins = new Map<CoreInstructionId, IRInstruction>();
	const instructionLowering = new Map<CoreInstructionId, LegacyInstructionLowering>();
	const legacyRegisters = new Map<CoreValueId, number>();
	const legacyBlockByCoreBlock = new Map<CoreBlockId, number>();
	const coreBlocks: Array<CoreBlockId> = [];
	const blockRegisters: Array<Array<number>> = [];
	for (const segment of segments) {
		const liveIn = sortedRegisters(segment.liveIn);
		blockRegisters.push(liveIn);
		const block = builder.createBlock([
			...(segment.catchRegister === undefined
				? []
				: [{ role: "exception" as const, representation: "boxed" as const }]),
			...liveIn.map(() => ({ representation: "boxed" as const })),
		]);
		coreBlocks.push(block);
		if (retainLoweringMetadata) legacyBlockByCoreBlock.set(block, segment.oldBlock);
		const parameters = builder.block(block).parameters;
		let parameterIndex = 0;
		if (segment.catchRegister !== undefined) {
			if (segment.catchRegister >= 0) {
				if (retainLoweringMetadata) {
					legacyRegisters.set(parameters[parameterIndex]!.value, segment.catchRegister);
				}
			}
			parameterIndex++;
		}
		for (const register of liveIn) {
			const parameter = parameters[parameterIndex++]!.value;
			if (retainLoweringMetadata) legacyRegisters.set(parameter, register);
		}
	}

	const requireValue = (
		values: ReadonlyMap<number, CoreValueId>,
		register: number,
		context: string,
	): CoreValueId => {
		const value = values.get(register);
		if (value === undefined) {
			throw new Error(`${context} reads uninitialized legacy register ${register}`);
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
				retainLoweringMetadata,
				sourcePosition,
				(register, context) => requireValue(values, register, context),
			);
			const destinations = definedRegisters(instruction);
			const lowering = legacyPayload(
				instruction,
				retainLoweringMetadata,
				expandedImmediates,
			);
			const outputs = builder.appendInstruction(block, instruction.type, inputs, {
				outputCount: destinations.length,
				outputRepresentations: destinations.map((_, index) =>
					outputRepresentation(instruction, index),
				),
				attributes: lowering.attributes,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			});
			const appended = builder.block(block).instructions.at(-1);
			if (appended === undefined) {
				throw new Error(`Core bridge failed to append ${instruction.type}`);
			}
			if (retainLoweringMetadata) instructionOrigins.set(appended.id, instruction);
			if (retainLoweringMetadata) instructionLowering.set(appended.id, lowering);
			for (const [index, register] of destinations.entries()) {
				values.set(register, outputs[index]!);
				if (retainLoweringMetadata) legacyRegisters.set(outputs[index]!, register);
			}
		}

		const edge = (target: number, sourceValues = values): CoreEdge => ({
			block: coreBlocks[target]!,
			arguments: blockRegisters[target]!.map((register) =>
				requireValue(sourceValues, register, `Core edge b${segment.id} -> b${target}`),
			),
		});
		const legacyTerminator = segment.terminator!;
		let terminator: CoreTerminatorInput;
		switch (legacyTerminator.kind) {
			case "jump":
				terminator = {
					kind: "jump",
					edge: edge(legacyTerminator.target),
					...(legacyTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: legacyTerminator.sourcePosition }),
				};
				break;
			case "branch":
				terminator = {
					kind: "branch",
					condition: requireValue(values, legacyTerminator.condition, "Core branch"),
					consequent: edge(legacyTerminator.consequent),
					alternate: edge(legacyTerminator.alternate),
					...(legacyTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: legacyTerminator.sourcePosition }),
				};
				break;
			case "return":
			case "throw":
				terminator = {
					kind: legacyTerminator.kind,
					value: requireValue(
						values,
						legacyTerminator.value,
						`Core ${legacyTerminator.kind}`,
					),
					...(legacyTerminator.sourcePosition === undefined
						? {}
						: { sourcePosition: legacyTerminator.sourcePosition }),
				};
				break;
			case "unreachable":
				terminator = { kind: "unreachable" };
				break;
		}
		const terminatorId = builder.setTerminator(block, terminator);
		if ("origin" in legacyTerminator && legacyTerminator.origin !== undefined) {
			if (retainLoweringMetadata) {
				instructionOrigins.set(terminatorId, legacyTerminator.origin);
			}
		}
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
	const core =
		bodyEntrySegment === undefined
			? finished
			: { ...finished, bodyEntry: coreBlockId(bodyEntrySegment.id) };
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
		legacy: fn,
		instructionOrigins,
		instructionLowering,
		legacyRegisters,
		legacyBlockByCoreBlock,
	};
}

/** Convert normalized semantic-lowering output into canonical block-parameter SSA. */
export function intermediateProgramToCore(
	program: IntermediateProgram,
	options: CoreProgramConstructionOptions = {},
): CoreProgramBridge {
	const verify = options.verify ?? true;
	const retainLoweringMetadata = options.retainLoweringMetadata ?? true;
	const converted = program.functions.map((fn) =>
		convertFunction(fn, false, retainLoweringMetadata),
	);
	const core: CoreProgram = {
		functions: converted.map(({ core }) => core),
		stringConstants: program.stringConstants.map((units) => [...units]),
		bigintConstants: [...program.bigintConstants],
		literalTemplateData: [...program.literalTemplateData],
		sourcePositions: program.sourcePositions.map((position) => ({ ...position })),
		globalCount: program.nextGlobalIndex,
	};
	if (verify) verifyCoreProgram(core, coreOpcodeRegistry);
	return {
		source: program,
		core,
		lowering: converted.map(({ core: _core, ...lowering }) => lowering),
	};
}

function parallelMoves(
	assignments: ReadonlyArray<{ readonly destination: number; readonly source: number }>,
	nextRegister: { value: number },
): Array<IRInstruction> {
	const pending = assignments
		.filter(({ destination, source }) => destination !== source)
		.map((assignment) => ({ ...assignment }));
	const result: Array<IRInstruction> = [];
	while (pending.length > 0) {
		const ready = pending.findIndex(
			({ destination }) => !pending.some(({ source }) => source === destination),
		);
		if (ready >= 0) {
			const [assignment] = pending.splice(ready, 1);
			result.push({
				type: "move",
				registers: [assignment!.destination, assignment!.source],
			});
			continue;
		}
		const saved = pending[0]!.destination;
		const temporary = nextRegister.value++;
		result.push({ type: "move", registers: [temporary, saved] });
		for (const assignment of pending) {
			if (assignment.source === saved) assignment.source = temporary;
		}
	}
	return result;
}

function rebuildInstruction(
	instruction: CoreFunction["blocks"][number]["instructions"][number],
	origin: IRInstruction | undefined,
	lowering: LegacyInstructionLowering | undefined,
	registerForValue: (value: CoreValueId) => number,
): IRInstruction {
	const retainedLayout =
		origin?.type === instruction.opcode ? lowering?.registerLayout : undefined;
	const registerLayout =
		retainedLayout ?? [
			...instruction.outputs.map((_, index) => ({ kind: "output" as const, index })),
			...instruction.inputs.map((_, index) => ({ kind: "input" as const, index })),
		];
	const rebuilt = {
		type: instruction.opcode,
		...instruction.attributes,
		...(lowering?.registerLayout === undefined && registerLayout.length === 0
			? {}
			: {
					registers: registerLayout.map((operand) => {
						switch (operand.kind) {
							case "output":
								return registerForValue(instruction.outputs[operand.index]!);
							case "input":
								return registerForValue(instruction.inputs[operand.index]!);
							case "literal":
								return operand.value;
						}
					}),
				}),
	} as IRInstruction;
	if (origin === undefined || origin.type !== rebuilt.type) return rebuilt;
	for (const key of Object.keys(origin)) {
		delete (origin as unknown as Record<string, unknown>)[key];
	}
	Object.assign(origin, rebuilt);
	return origin;
}

function sourcePositionMarker(position: number | undefined): Array<IRInstruction> {
	return position === undefined ? [] : [{ type: "sourcePos", pos: position }];
}

function lowerFunctionBridge(
	core: CoreFunction,
	lowering: CoreFunctionLowering,
): IRFunction {
	const { legacy } = lowering;
	verifyCoreFunction(core, coreOpcodeRegistry);
	// Legacy region certificates contain a graph of instruction identities and
	// exact control-flow envelopes. They stay on their already optimized lowering
	// path until each region kind becomes an explicit Core operation/fact; silently
	// approximating those proofs during de-SSA would be a correctness bug.
	if ((legacy.regions?.length ?? 0) > 0) return legacy;
	const blocks: Array<IRBlock> = core.blocks.map(() => ({ instructions: [] }));
	const nextRegister = {
		value:
			Math.max(legacy.nextRegisterDestination - 1, ...lowering.legacyRegisters.values()) +
			1,
	};
	const allocatedRegisters = new Map(lowering.legacyRegisters);
	const registerForValue = (value: CoreValueId): number => {
		let register = allocatedRegisters.get(value);
		if (register === undefined) {
			register = nextRegister.value++;
			allocatedRegisters.set(value, register);
		}
		return register;
	};

	const edgeBlock = (edge: CoreEdge): number => {
		const target = core.blocks[edge.block]!;
		if (target.parameters[0]?.role === "exception") {
			throw new Error(`Ordinary Core edge targets exception block ${edge.block}`);
		}
		const instructions = parallelMoves(
			target.parameters.map((parameter, index) => ({
				destination: registerForValue(parameter.value),
				source: registerForValue(edge.arguments[index]!),
			})),
			nextRegister,
		);
		if (instructions.length === 0) return edge.block;
		const index = blocks.length;
		blocks.push({
			instructions: [...instructions, { type: "jump", blocks: [edge.block] }],
		});
		return index;
	};

	for (const block of core.blocks) {
		const instructions = blocks[block.id]!.instructions;
		if (block.handler !== undefined) {
			const target = core.blocks[block.handler.block]!;
			const explicitParameters = target.parameters.slice(1);
			instructions.push({
				type: "tryBegin",
				blocks: [block.handler.block, block.id],
			});
			instructions.push(
				...parallelMoves(
					explicitParameters.map((parameter, index) => ({
						destination: registerForValue(parameter.value),
						source: registerForValue(block.handler!.arguments[index]!),
					})),
					nextRegister,
				),
			);
		}
		if (block.parameters[0]?.role === "exception") {
			instructions.push({
				type: "catch",
				registers: [registerForValue(block.parameters[0].value)],
			});
		}
		for (const instruction of block.instructions) {
			instructions.push(...sourcePositionMarker(instruction.sourcePosition));
			instructions.push(
				rebuildInstruction(
					instruction,
					lowering.instructionOrigins.get(instruction.id),
					lowering.instructionLowering.get(instruction.id),
					registerForValue,
				),
			);
		}
		instructions.push(...sourcePositionMarker(block.terminator.sourcePosition));
		switch (block.terminator.kind) {
			case "jump":
				instructions.push(
					rebuildInstruction(
						{
							id: block.terminator.id,
							opcode: "jump",
							inputs: [],
							outputs: [],
							attributes: { blocks: [edgeBlock(block.terminator.edge)] },
						},
						lowering.instructionOrigins.get(block.terminator.id),
						undefined,
						registerForValue,
					),
				);
				break;
			case "branch":
				instructions.push(
					rebuildInstruction(
						{
							id: block.terminator.id,
							opcode: "jumpIf",
							inputs: [block.terminator.condition],
							outputs: [],
							attributes: { blocks: [edgeBlock(block.terminator.consequent)] },
						},
						lowering.instructionOrigins.get(block.terminator.id),
						undefined,
						registerForValue,
					),
					{ type: "jump", blocks: [edgeBlock(block.terminator.alternate)] },
				);
				break;
			case "guard":
				instructions.push(
					{
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.success)],
					},
					{ type: "jump", blocks: [edgeBlock(block.terminator.fallback)] },
				);
				break;
			case "return":
			case "throw":
				instructions.push(
					rebuildInstruction(
						{
							id: block.terminator.id,
							opcode: block.terminator.kind,
							inputs: [block.terminator.value],
							outputs: [],
							attributes: {},
						},
						lowering.instructionOrigins.get(block.terminator.id),
						undefined,
						registerForValue,
					),
				);
				break;
			case "switch":
				throw new Error("Core switch lowering is not implemented yet");
			case "unreachable":
				throw new Error(`Reachable Core block ${block.id} ends in unreachable`);
		}
		if (block.handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	return {
		...legacy,
		blocks,
		regions: undefined,
		nextRegisterDestination: nextRegister.value,
		bodyEntryBlock: core.bodyEntry,
	};
}

/** Lower canonical SSA back into the existing VM-facing register form. */
export function coreProgramToIntermediate(
	bridge: CoreProgramBridge,
): IntermediateProgram {
	return {
		...bridge.source,
		functions: bridge.core.functions.map((fn, index) =>
			lowerFunctionBridge(fn, bridge.lowering[index]!),
		),
	};
}
