import { coreOpcode, coreOpcodeRegistry, isCoreOpcode } from "./core-ir-opcodes.ts";
import { coreTerminatorEdges } from "./core-ir-control-flow.ts";
import { verifyCoreFunction, verifyCoreProgram } from "./core-ir-verifier.ts";
import { CoreFunctionBuilder, coreBlockId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreImmediate,
	CoreInstructionId,
	CoreInstructionAttributes,
	CoreFunctionMetadata,
	CoreProgram,
	CoreRegion,
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
	IRRegion,
} from "./ir.ts";
import { inferVirtualReps } from "./register-alloc.ts";
import type { RegisterRep } from "./register-alloc.ts";

interface LegacyToken {
	readonly instruction: IRInstruction;
	readonly sourcePosition?: number;
}

type SegmentTerminator =
	| {
			readonly kind: "jump";
			readonly target: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<IRInstruction>;
	  }
	| {
			readonly kind: "branch";
			readonly condition: number;
			readonly consequent: number;
			readonly alternate: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<IRInstruction>;
	  }
	| {
			readonly kind: "return";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<IRInstruction>;
	  }
	| {
			readonly kind: "throw";
			readonly value: number;
			readonly sourcePosition?: number;
			readonly origins?: ReadonlyArray<IRInstruction>;
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

export interface CoreProgramBridge {
	readonly source: IntermediateProgram;
	readonly core: CoreProgram;
}

interface ConvertedCoreFunction {
	readonly core: CoreFunction;
}

export interface CoreProgramConstructionOptions {
	/**
	 * Run the whole-program verifier after construction. Direct bridge users get
	 * this by default; callers may omit it only when another phase owns the same
	 * verification boundary.
	 */
	readonly verify?: boolean;
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
	registerRepresentations: ReadonlyMap<number, RegisterRep>,
): CoreRepresentation {
	if (instruction.type === "createNumber" || instruction.type === "createF64") return "f64";
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
	const inferred = register === undefined ? undefined : registerRepresentations.get(register);
	if (inferred === "number") return "f64";
	if (inferred === "boolean") return "boolean";
	return "boxed";
}

function coreRegisterRepresentation(
	registerRepresentations: ReadonlyMap<number, RegisterRep>,
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

const CORE_REGION_COMMON_FIELDS = new Set([
	"kind",
	"anchors",
	"claimedInstructions",
	"controlFlow",
]);

function coreRegionData(
	value: unknown,
	instructionIds: ReadonlyMap<IRInstruction, CoreInstructionId>,
	coreBlocksByLegacyBlock: ReadonlyMap<number, ReadonlyArray<CoreBlockId>>,
): unknown {
	if (value === undefined || value === null || typeof value !== "object") return value;
	const instruction = instructionIds.get(value as IRInstruction);
	if (instruction !== undefined) return { $coreInstruction: instruction };
	if (Array.isArray(value)) {
		return value.map((entry) =>
			coreRegionData(entry, instructionIds, coreBlocksByLegacyBlock),
		);
	}
	if (
		"type" in value &&
		typeof value.type === "string" &&
		(("registers" in value && Array.isArray(value.registers)) ||
			("blocks" in value && Array.isArray(value.blocks)))
	) {
		throw new Error(`Core region references an instruction outside its function graph`);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "exitBlock" && typeof entry === "number") {
			const block = coreBlocksByLegacyBlock.get(entry)?.[0];
			if (block === undefined) {
				throw new Error(`Core region references unknown exit block ${entry}`);
			}
			result[key] = { $coreBlock: block };
		} else {
			result[key] = coreRegionData(
				entry,
				instructionIds,
				coreBlocksByLegacyBlock,
			);
		}
	}
	return result;
}

function convertRegions(
	regions: ReadonlyArray<IRRegion> | undefined,
	instructionIds: ReadonlyMap<IRInstruction, CoreInstructionId>,
	coreBlocksByLegacyBlock: ReadonlyMap<number, ReadonlyArray<CoreBlockId>>,
): ReadonlyArray<CoreRegion> {
	if (regions === undefined) return [];
	const requireInstruction = (instruction: IRInstruction): CoreInstructionId => {
		const id = instructionIds.get(instruction);
		if (id === undefined) {
			throw new Error(`Core region references missing ${instruction.type} instruction`);
		}
		return id;
	};
	const blocks = (legacyBlocks: ReadonlyArray<number>): Array<CoreBlockId> =>
		legacyBlocks.flatMap((block) => {
			const converted = coreBlocksByLegacyBlock.get(block);
			if (converted === undefined) {
				throw new Error(`Core region references missing legacy block ${block}`);
			}
			return converted;
		});
	const handlerBlocks = (legacyBlocks: ReadonlyArray<number>): Array<CoreBlockId> =>
		legacyBlocks.map((block) => {
			const converted = coreBlocksByLegacyBlock.get(block)?.[0];
			if (converted === undefined) {
				throw new Error(`Core region references missing legacy handler block ${block}`);
			}
			return converted;
		});
	return regions.map((region) => {
		const data: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(region)) {
			if (CORE_REGION_COMMON_FIELDS.has(key)) continue;
			if (key === "exitBlock" && typeof value === "number") {
				const block = coreBlocksByLegacyBlock.get(value)?.[0];
				if (block === undefined) {
					throw new Error(`Core region references unknown exit block ${value}`);
				}
				data[key] = { $coreBlock: block };
			} else {
				data[key] = coreRegionData(
					value,
					instructionIds,
					coreBlocksByLegacyBlock,
				);
			}
		}
		return {
			kind: region.kind,
			anchors: region.anchors.map(requireInstruction),
			claimedInstructions: region.claimedInstructions.map(requireInstruction),
			ordinaryBlocks: blocks(region.controlFlow.ordinaryBlocks),
			exceptionalBlocks: handlerBlocks(region.controlFlow.exceptionalBlocks),
			data: data as CoreRegion["data"],
		};
	});
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
						origins: [instruction],
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
	registerRepresentations: ReadonlyMap<number, RegisterRep>,
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
	const instructionIds = new Map<IRInstruction, CoreInstructionId>();
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
			instructionIds.set(instruction, id);
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
					throw new Error(`${context} reads uninitialized legacy register ${register}`);
				}
				return value;
			},
		);
		const destinations = definedRegisters(instruction);
		const attributes = legacyPayload(instruction, expandedImmediates);
		const outputs = builder.appendInstruction(block, instruction.type, inputs, {
			outputCount: destinations.length,
			outputRepresentations: destinations.map((_, index) =>
				outputRepresentation(instruction, index, registerRepresentations),
			),
			attributes,
			...(sourcePosition === undefined ? {} : { sourcePosition }),
		});
		instructionIds.set(instruction, builder.block(block).instructions.at(-1)!.id);
		for (const [index, register] of destinations.entries()) {
			values.set(register, outputs[index]!);
		}
	}
	const finished = builder.finish(block);
	const graph =
		fn.bodyEntryBlock === 0
			? { ...finished, bodyEntry: block }
			: finished;
	const core = {
		...graph,
		regions: convertRegions(fn.regions, instructionIds, new Map([[0, [block]]])),
	};
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
	};
}

function convertFunction(
	fn: IRFunction,
	verify: boolean,
): ConvertedCoreFunction {
	const registerRepresentations = inferVirtualReps(fn);
	const straightLine = convertStraightLineFunction(
		fn,
		verify,
		registerRepresentations,
	);
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
	const coreBlocks: Array<CoreBlockId> = [];
	const blockRegisters: Array<Array<number>> = [];
	const coreBlocksByLegacyBlock = new Map<number, Array<CoreBlockId>>();
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
		const legacyBlocks = coreBlocksByLegacyBlock.get(segment.oldBlock) ?? [];
		legacyBlocks.push(block);
		coreBlocksByLegacyBlock.set(segment.oldBlock, legacyBlocks);
	}
	const instructionIds = new Map<IRInstruction, CoreInstructionId>();

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
				sourcePosition,
				(register, context) => requireValue(values, register, context),
			);
			const destinations = definedRegisters(instruction);
			const attributes = legacyPayload(instruction, expandedImmediates);
			const outputs = builder.appendInstruction(block, instruction.type, inputs, {
				outputCount: destinations.length,
				outputRepresentations: destinations.map((_, index) =>
					outputRepresentation(instruction, index, registerRepresentations),
				),
				attributes,
				...(sourcePosition === undefined ? {} : { sourcePosition }),
			});
			const appended = builder.block(block).instructions.at(-1);
			if (appended === undefined) {
				throw new Error(`Core bridge failed to append ${instruction.type}`);
			}
			instructionIds.set(instruction, appended.id);
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
		for (const origin of
			"origins" in legacyTerminator ? (legacyTerminator.origins ?? []) : []) {
			instructionIds.set(origin, terminatorId);
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
	const graph =
		bodyEntrySegment === undefined
			? finished
			: { ...finished, bodyEntry: coreBlockId(bodyEntrySegment.id) };
	const core = {
		...graph,
		regions: convertRegions(fn.regions, instructionIds, coreBlocksByLegacyBlock),
	};
	if (verify) verifyCoreFunction(core, coreOpcodeRegistry);
	return {
		core,
	};
}

/** Convert normalized semantic-lowering output into canonical block-parameter SSA. */
export function intermediateProgramToCore(
	program: IntermediateProgram,
	options: CoreProgramConstructionOptions = {},
): CoreProgramBridge {
	const verify = options.verify ?? true;
	const converted = program.functions.map((fn) => convertFunction(fn, false));
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
	core: CoreFunction,
	instruction: CoreFunction["blocks"][number]["instructions"][number],
	registerForValue: (value: CoreValueId) => number,
): IRInstruction {
	const registers = [...instruction.outputs, ...instruction.inputs].map(registerForValue);
	const immediateValues: Array<IRImmediateValue | undefined> = [];
	if (instruction.opcode === "call" || instruction.opcode === "construct") {
		for (const [index, input] of instruction.inputs.entries()) {
			const value = coreImmediateValue(core, input);
			if (value === undefined) continue;
			const position = instruction.outputs.length + index;
			registers[position] = -1;
			immediateValues[position] = value;
		}
	}
	return {
		type: instruction.opcode,
		...instruction.attributes,
		...(immediateValues.length === 0 ? {} : { immediateValues }),
		...(["asyncStart", "generatorStart", "initGlobalVars"].includes(instruction.opcode)
			? {}
			: { registers }),
	} as IRInstruction;
}

function coreImmediateValue(
	core: CoreFunction,
	value: CoreValueId,
): IRImmediateValue | undefined {
	const definition = core.values.find(({ id }) => id === value)?.definition;
	if (definition?.kind !== "instruction") return undefined;
	const instruction = core.blocks
		.flatMap(({ instructions }) => instructions)
		.find(({ id }) => id === definition.instruction);
	if (instruction === undefined || definition.index !== 0) return undefined;
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instruction.attributes.value === "boolean"
				? { kind: "boolean", value: instruction.attributes.value }
				: undefined;
		case "createNumber":
		case "createF64": {
			const number = instruction.attributes.value;
			return typeof number === "number" &&
				Number.isInteger(number) &&
				!Object.is(number, -0) &&
				number >= -0x0800_0000 &&
				number <= 0x07ff_ffff
				? { kind: "number", value: number }
				: undefined;
		}
		case "createString": {
			const index = instruction.attributes.stringIndex;
			return typeof index === "number" && index <= 0x0fff_ffff
				? { kind: "string", index }
				: undefined;
		}
		default:
			return undefined;
	}
}

function sourcePositionMarker(position: number | undefined): Array<IRInstruction> {
	return position === undefined ? [] : [{ type: "sourcePos", pos: position }];
}

function lowerCoreImmediate(
	value: CoreImmediate,
	destination: number,
): IRInstruction {
	switch (value.kind) {
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "boolean":
			return {
				type: "createBoolean",
				registers: [destination],
				value: value.value,
			};
		case "number":
			return {
				type: "createNumber",
				registers: [destination],
				value: value.value,
			};
		case "string":
			return {
				type: "createString",
				registers: [destination],
				stringIndex: value.index,
			};
	}
}

function lowerCoreRegionData(
	value: unknown,
	instructions: ReadonlyMap<CoreInstructionId, IRInstruction>,
	blocks: ReadonlyMap<CoreBlockId, number>,
): unknown {
	if (value === undefined || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((entry) => lowerCoreRegionData(entry, instructions, blocks));
	}
	const object = value as Readonly<Record<string, unknown>>;
	if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
		const instruction = instructions.get(object.$coreInstruction as CoreInstructionId);
		if (instruction === undefined) {
			throw new Error(
				`Core region lowering lost instruction @${object.$coreInstruction}`,
			);
		}
		return instruction;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreBlock === "number") {
		const block = blocks.get(object.$coreBlock as CoreBlockId);
		if (block === undefined) {
			throw new Error(`Core region lowering lost block b${object.$coreBlock}`);
		}
		return block;
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(object)) {
		result[key] = lowerCoreRegionData(entry, instructions, blocks);
	}
	return result;
}

function lowerCoreRegions(
	regions: ReadonlyArray<CoreRegion>,
	instructions: ReadonlyMap<CoreInstructionId, IRInstruction>,
	omittedBlocks: ReadonlySet<CoreBlockId>,
	blocks: ReadonlyMap<CoreBlockId, number>,
): ReadonlyArray<IRRegion> | undefined {
	if (regions.length === 0) return undefined;
	const requireInstruction = (id: CoreInstructionId): IRInstruction => {
		const instruction = instructions.get(id);
		if (instruction === undefined) {
			throw new Error(`Core region lowering lost instruction @${id}`);
		}
		return instruction;
	};
	const requireBlock = (id: CoreBlockId): number => {
		const block = blocks.get(id);
		if (block === undefined) throw new Error(`Core region lowering lost block b${id}`);
		return block;
	};
	return regions.map((region) => ({
		...(lowerCoreRegionData(region.data, instructions, blocks) as object),
		kind: region.kind,
		anchors: region.anchors.map(requireInstruction),
		claimedInstructions: region.claimedInstructions.map(requireInstruction),
		controlFlow: {
			ordinaryBlocks: region.ordinaryBlocks
				.filter((block) => !omittedBlocks.has(block))
				.map(requireBlock),
			exceptionalBlocks: region.exceptionalBlocks.filter(
				(block) => !omittedBlocks.has(block),
			).map(requireBlock),
		},
	})) as unknown as ReadonlyArray<IRRegion>;
}

export function coreRegisterClasses(core: CoreFunction): {
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly registers: Map<CoreValueId, number>;
} {
	const representations = new Map(
		core.values.map(({ id, representation }) => [id, representation]),
	);
	const uses = core.blocks.map(() => new Set<CoreValueId>());
	const definitions = core.blocks.map(() => new Set<CoreValueId>());
	const successors = core.blocks.map(() => new Set<CoreBlockId>());
	const terminatorValues = (block: CoreFunction["blocks"][number]): Array<CoreValueId> => {
		const edgeArguments = coreTerminatorEdges(block.terminator).flatMap(
			(edge) => edge.arguments,
		);
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				return [block.terminator.condition, ...edgeArguments];
			case "switch":
				return [block.terminator.discriminant, ...edgeArguments];
			case "return":
			case "throw":
				return [block.terminator.value];
			case "jump":
				return edgeArguments;
			case "unreachable":
				return [];
		}
	};
	for (const block of core.blocks) {
		const blockUses = uses[block.id]!;
		const blockDefinitions = definitions[block.id]!;
		for (const { value } of block.parameters) blockDefinitions.add(value);
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) addUse(input);
			for (const output of instruction.outputs) blockDefinitions.add(output);
		}
		for (const value of terminatorValues(block)) addUse(value);
		for (const argument of block.handler?.arguments ?? []) addUse(argument);
		for (const edge of coreTerminatorEdges(block.terminator)) {
			successors[block.id]!.add(edge.block);
		}
		if (block.handler !== undefined) successors[block.id]!.add(block.handler.block);
	}
	const liveIn = core.blocks.map((_, index) => new Set(uses[index]));
	const liveOut = core.blocks.map(() => new Set<CoreValueId>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = core.blocks.length - 1; index >= 0; index--) {
			const nextOut = new Set<CoreValueId>();
			for (const successor of successors[index]!) {
				for (const value of liveIn[successor]!) nextOut.add(value);
			}
			const nextIn = new Set(uses[index]);
			for (const value of nextOut) {
				if (!definitions[index]!.has(value)) nextIn.add(value);
			}
			if (
				nextOut.size !== liveOut[index]!.size ||
				[...nextOut].some((value) => !liveOut[index]!.has(value)) ||
				nextIn.size !== liveIn[index]!.size ||
				[...nextIn].some((value) => !liveIn[index]!.has(value))
			) {
				liveOut[index] = nextOut;
				liveIn[index] = nextIn;
				changed = true;
			}
		}
	}
	const interference = new Map<CoreValueId, Set<CoreValueId>>(
		core.values.map(({ id }) => [id, new Set()]),
	);
	const interfere = (left: CoreValueId, right: CoreValueId): void => {
		if (left === right) return;
		interference.get(left)!.add(right);
		interference.get(right)!.add(left);
	};
	for (const block of core.blocks) {
		const live = new Set(liveOut[block.id]);
		for (const value of terminatorValues(block)) live.add(value);
		for (const argument of block.handler?.arguments ?? []) live.add(argument);
		for (let index = block.instructions.length - 1; index >= 0; index--) {
			const instruction = block.instructions[index]!;
			for (const output of instruction.outputs) {
				for (const value of live) interfere(output, value);
			}
			for (const left of instruction.outputs) {
				for (const right of instruction.outputs) interfere(left, right);
				live.delete(left);
			}
			for (const input of instruction.inputs) live.add(input);
		}
		for (const { value } of block.parameters) {
			for (const liveValue of live) interfere(value, liveValue);
			for (const { value: other } of block.parameters) interfere(value, other);
		}
	}
	const parent = new Map<CoreValueId, CoreValueId>(
		core.values.map(({ id }) => [id, id]),
	);
	const members = new Map<CoreValueId, Set<CoreValueId>>(
		core.values.map(({ id }) => [id, new Set([id])]),
	);
	const abi = new Map<CoreValueId, number>(
		core.parameters.map((value, index) => [value, index]),
	);
	const find = (value: CoreValueId): CoreValueId => {
		const direct = parent.get(value)!;
		if (direct === value) return value;
		const root = find(direct);
		parent.set(value, root);
		return root;
	};
	const union = (left: CoreValueId, right: CoreValueId): boolean => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return true;
		if (representations.get(leftRoot) !== representations.get(rightRoot)) return false;
		const leftAbi = [...members.get(leftRoot)!].flatMap((value) =>
			abi.has(value) ? [abi.get(value)!] : [],
		);
		const rightAbi = [...members.get(rightRoot)!].flatMap((value) =>
			abi.has(value) ? [abi.get(value)!] : [],
		);
		if (leftAbi.length > 0 && rightAbi.length > 0 && leftAbi[0] !== rightAbi[0]) {
			return false;
		}
		if (
			[...members.get(leftRoot)!].some((leftValue) =>
				[...members.get(rightRoot)!].some((rightValue) =>
					interference.get(leftValue)!.has(rightValue),
				),
			)
		) {
			return false;
		}
		parent.set(rightRoot, leftRoot);
		for (const value of members.get(rightRoot)!) members.get(leftRoot)!.add(value);
		members.delete(rightRoot);
		return true;
	};
	for (const block of core.blocks) {
		if (block.id === core.entry || block.parameters[0]?.role === "exception") continue;
		for (const [index, parameter] of block.parameters.entries()) {
			const arguments_ = core.blocks.flatMap((predecessor) =>
				coreTerminatorEdges(predecessor.terminator)
					.filter((edge) => edge.block === block.id)
					.map((edge) => edge.arguments[index]!),
			);
			for (const argument of arguments_) union(parameter.value, argument);
		}
	}
	const roots = new Map<CoreValueId, CoreValueId>(
		core.values.map(({ id }) => [id, find(id)]),
	);
	const registers = new Map<CoreValueId, number>();
	for (const [index, parameter] of core.parameters.entries()) {
		registers.set(find(parameter), index);
	}
	return { roots, registers };
}

function coreRegionInstructionIds(core: CoreFunction): ReadonlySet<CoreInstructionId> {
	const result = new Set<CoreInstructionId>();
	const visit = (value: unknown): void => {
		if (value === undefined || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		const object = value as Readonly<Record<string, unknown>>;
		if (
			Object.keys(object).length === 1 &&
			typeof object.$coreInstruction === "number"
		) {
			result.add(object.$coreInstruction as CoreInstructionId);
			return;
		}
		for (const entry of Object.values(object)) visit(entry);
	};
	for (const region of core.regions) {
		for (const id of region.anchors) result.add(id);
		for (const id of region.claimedInstructions) result.add(id);
		visit(region.data);
	}
	return result;
}

function immediateOnlyInstructions(
	core: CoreFunction,
	protectedInstructions: ReadonlySet<CoreInstructionId>,
): ReadonlySet<CoreInstructionId> {
	const embedded = new Set<CoreValueId>();
	const ordinary = new Set<CoreValueId>();
	for (const block of core.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) {
				if (
					(instruction.opcode === "call" || instruction.opcode === "construct") &&
					coreImmediateValue(core, input) !== undefined
				) {
					embedded.add(input);
				} else {
					ordinary.add(input);
				}
			}
		}
		const ordinaryTerminatorUse = (value: CoreValueId): void => {
			ordinary.add(value);
		};
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				ordinaryTerminatorUse(block.terminator.condition);
				break;
			case "switch":
				ordinaryTerminatorUse(block.terminator.discriminant);
				break;
			case "return":
			case "throw":
				ordinaryTerminatorUse(block.terminator.value);
				break;
			case "jump":
			case "unreachable":
				break;
		}
		for (const edge of coreTerminatorEdges(block.terminator)) {
			for (const argument of edge.arguments) ordinaryTerminatorUse(argument);
		}
		for (const argument of block.handler?.arguments ?? []) ordinaryTerminatorUse(argument);
	}
	return new Set(
		core.blocks.flatMap((block) =>
			block.instructions.flatMap((instruction) =>
				!protectedInstructions.has(instruction.id) &&
				instruction.outputs.length > 0 &&
				instruction.outputs.every(
					(output) => embedded.has(output) && !ordinary.has(output),
				)
					? [instruction.id]
					: [],
			),
		),
	);
}

function coreBlockLayout(
	core: CoreFunction,
	omitted: ReadonlySet<CoreBlockId>,
): Array<CoreBlockId> {
	const forwardingTarget = (block: CoreBlockId): CoreBlockId => {
		let current = block;
		const seen = new Set<CoreBlockId>();
		while (omitted.has(current)) {
			if (seen.has(current)) throw new Error(`Cyclic omitted Core block b${current}`);
			seen.add(current);
			const forwarding = core.blocks[current]!;
			if (forwarding.terminator.kind !== "jump") {
				throw new Error(`Omitted Core block b${current} is not a forwarding block`);
			}
			current = forwarding.terminator.edge.block;
		}
		return current;
	};
	const successors = (block: CoreFunction["blocks"][number]): Array<CoreBlockId> => {
		const exceptional =
			block.handler === undefined ? [] : [forwardingTarget(block.handler.block)];
		switch (block.terminator.kind) {
			case "jump":
				return [...exceptional, forwardingTarget(block.terminator.edge.block)];
			case "branch":
				return [
					...exceptional,
					forwardingTarget(block.terminator.alternate.block),
					forwardingTarget(block.terminator.consequent.block),
				];
			case "guard":
				return [
					...exceptional,
					forwardingTarget(block.terminator.fallback.block),
					forwardingTarget(block.terminator.success.block),
				];
			case "switch":
				return [
					...exceptional,
					forwardingTarget(block.terminator.default.block),
					...block.terminator.cases
						.toReversed()
						.map(({ edge }) => forwardingTarget(edge.block)),
				];
			case "return":
			case "throw":
			case "unreachable":
				return exceptional;
		}
	};

	const visited = new Set<CoreBlockId>();
	const order: Array<CoreBlockId> = [];
	const visit = (start: CoreBlockId): void => {
		if (omitted.has(start) || visited.has(start)) return;
		const postorder: Array<CoreBlockId> = [];
		visited.add(start);
		const stack: Array<{
			readonly block: CoreBlockId;
			readonly successors: ReadonlyArray<CoreBlockId>;
			index: number;
		}> = [{ block: start, successors: successors(core.blocks[start]!), index: 0 }];
		while (stack.length > 0) {
			const frame = stack.at(-1)!;
			if (frame.index >= frame.successors.length) {
				postorder.push(frame.block);
				stack.pop();
				continue;
			}
			const next = frame.successors[frame.index++]!;
			if (omitted.has(next) || visited.has(next)) continue;
			visited.add(next);
			stack.push({ block: next, successors: successors(core.blocks[next]!), index: 0 });
		}
		order.push(...postorder.toReversed());
	};
	visit(core.entry);
	for (const block of core.blocks) visit(block.id);
	return order;
}

function lowerFunctionBridge(
	core: CoreFunction,
	legacy: IRFunction,
): IRFunction {
	verifyCoreFunction(core, coreOpcodeRegistry);
	const loweredInstructions = new Map<CoreInstructionId, IRInstruction>();
	const protectedInstructions = coreRegionInstructionIds(core);
	const omittedInstructions = immediateOnlyInstructions(core, protectedInstructions);
	const predecessorCounts = core.blocks.map(() => 0);
	for (const block of core.blocks) {
		for (const edge of coreTerminatorEdges(block.terminator)) {
			predecessorCounts[edge.block]!++;
		}
		if (block.handler !== undefined) predecessorCounts[block.handler.block]!++;
	}
	const absorbedAlternateBlocks = new Set<CoreBlockId>();
	for (const block of core.blocks) {
		const alternate =
			block.terminator.kind === "branch"
				? block.terminator.alternate
				: block.terminator.kind === "guard"
					? block.terminator.fallback
					: undefined;
		if (alternate === undefined) continue;
		const forwarding = core.blocks[alternate.block]!;
		if (
			predecessorCounts[forwarding.id] === 1 &&
			forwarding.id !== core.entry &&
			forwarding.id !== core.bodyEntry &&
			forwarding.parameters[0]?.role !== "exception" &&
			forwarding.instructions.length === 0 &&
			forwarding.handler === undefined &&
			forwarding.terminator.kind === "jump"
		) {
			absorbedAlternateBlocks.add(forwarding.id);
		}
	}
	const blockOrder = coreBlockLayout(core, absorbedAlternateBlocks);
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	const blocks: Array<IRBlock> = blockOrder.map(() => ({ instructions: [] }));
	const nextRegister = { value: core.parameters.length };
	const { roots, registers: allocatedRegisters } = coreRegisterClasses(core);
	const registerForValue = (value: CoreValueId): number => {
		const root = roots.get(value)!;
		let register = allocatedRegisters.get(root);
		if (register === undefined) {
			register = nextRegister.value++;
			allocatedRegisters.set(root, register);
		}
		return register;
	};

	const edgeBlock = (edge: CoreEdge): number => {
		const target = core.blocks[edge.block]!;
		const loweredTarget = loweredBlockForCore.get(edge.block);
		if (loweredTarget === undefined) {
			throw new Error(`Ordinary Core edge targets omitted block ${edge.block}`);
		}
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
		if (instructions.length === 0) return loweredTarget;
		const index = blocks.length;
		blocks.push({
			instructions: [...instructions, { type: "jump", blocks: [loweredTarget] }],
		});
		return index;
	};
	const absorbAlternate = (
		edge: CoreEdge,
	): { readonly edge: CoreEdge; readonly terminator: CoreInstructionId } | undefined => {
		if (!absorbedAlternateBlocks.has(edge.block)) return undefined;
		const forwarding = core.blocks[edge.block]!;
		if (forwarding.terminator.kind !== "jump") return undefined;
		const substitutions = new Map(
			forwarding.parameters.map((parameter, index) => [
				parameter.value,
				edge.arguments[index]!,
			]),
		);
		return {
			edge: {
				block: forwarding.terminator.edge.block,
				arguments: forwarding.terminator.edge.arguments.map(
					(argument) => substitutions.get(argument) ?? argument,
				),
			},
			terminator: forwarding.terminator.id,
		};
	};
	const nextEmittedBlock = (block: CoreBlockId): number | undefined => {
		const lowered = loweredBlockForCore.get(block);
		return lowered === undefined || lowered + 1 >= blockOrder.length
			? undefined
			: lowered + 1;
	};

	for (const coreBlock of blockOrder) {
		const block = core.blocks[coreBlock]!;
		const loweredBlock = loweredBlockForCore.get(block.id)!;
		const instructions = blocks[loweredBlock]!.instructions;
		if (block.handler !== undefined) {
			const target = core.blocks[block.handler.block]!;
			const loweredHandler = loweredBlockForCore.get(block.handler.block);
			if (loweredHandler === undefined) {
				throw new Error(`Core handler targets omitted block ${block.handler.block}`);
			}
			const explicitParameters = target.parameters.slice(1);
			instructions.push({
				type: "tryBegin",
				blocks: [loweredHandler, loweredBlock],
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
			if (omittedInstructions.has(instruction.id)) continue;
			instructions.push(...sourcePositionMarker(instruction.sourcePosition));
			const lowered = rebuildInstruction(core, instruction, registerForValue);
			if (lowered.type === "constructSuperExplicit") {
				// Core models current-this as an ordinary SSA input. The compact VM op is
				// two-address, so satisfy that target constraint here instead of leaking it
				// into Core value allocation.
				const destination = lowered.registers[0];
				const currentThis = lowered.registers[4];
				if (destination !== currentThis) {
					instructions.push({
						type: "move",
						registers: [destination, currentThis],
					});
				}
				lowered.registers[4] = destination;
			}
			instructions.push(lowered);
			loweredInstructions.set(instruction.id, lowered);
		}
		instructions.push(...sourcePositionMarker(block.terminator.sourcePosition));
		switch (block.terminator.kind) {
			case "jump":
				{
					const target = edgeBlock(block.terminator.edge);
					if (
						block.handler !== undefined &&
						!protectedInstructions.has(block.terminator.id) &&
						target === nextEmittedBlock(block.id)
					) {
						break;
					}
					const lowered: IRInstruction = {
						type: "jump",
						blocks: [target],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "branch":
				{
					const absorbed = absorbAlternate(block.terminator.alternate);
					const lowered: IRInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.consequent)],
					};
					const alternate: IRInstruction = {
						type: "jump",
						blocks: [edgeBlock(absorbed?.edge ?? block.terminator.alternate)],
					};
				instructions.push(
					lowered,
					alternate,
				);
				loweredInstructions.set(block.terminator.id, lowered);
				if (absorbed !== undefined) {
					loweredInstructions.set(absorbed.terminator, alternate);
				}
				}
				break;
			case "guard":
				{
					const absorbed = absorbAlternate(block.terminator.fallback);
					const lowered: IRInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.success)],
					};
					const fallback: IRInstruction = {
						type: "jump",
						blocks: [edgeBlock(absorbed?.edge ?? block.terminator.fallback)],
					};
				instructions.push(
					lowered,
					fallback,
				);
				loweredInstructions.set(block.terminator.id, lowered);
				if (absorbed !== undefined) {
					loweredInstructions.set(absorbed.terminator, fallback);
				}
				}
				break;
			case "return":
			case "throw":
				{
					const lowered: IRInstruction = {
					type: block.terminator.kind,
					registers: [registerForValue(block.terminator.value)],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "switch":
				for (const switchCase of block.terminator.cases) {
					const immediate = nextRegister.value++;
					const matches = nextRegister.value++;
					instructions.push(
						lowerCoreImmediate(switchCase.value, immediate),
						{
							type: "binary",
							registers: [
								matches,
								registerForValue(block.terminator.discriminant),
								immediate,
							],
							operator: "===",
						},
						{
							type: "jumpIf",
							registers: [matches],
							blocks: [edgeBlock(switchCase.edge)],
						},
					);
				}
				instructions.push({
					type: "jump",
					blocks: [edgeBlock(block.terminator.default)],
				});
				break;
			case "unreachable":
				throw new Error(`Reachable Core block ${block.id} ends in unreachable`);
		}
		if (block.handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	return {
		...legacy,
		blocks,
		regions: lowerCoreRegions(
			core.regions,
			loweredInstructions,
			absorbedAlternateBlocks,
			loweredBlockForCore,
		),
		nextRegisterDestination: nextRegister.value,
		bodyEntryBlock:
			core.bodyEntry === undefined
				? undefined
				: loweredBlockForCore.get(core.bodyEntry),
	};
}

/** Lower canonical SSA back into the existing VM-facing register form. */
export function coreProgramToIntermediate(
	bridge: CoreProgramBridge,
): IntermediateProgram {
	return {
		...bridge.source,
		functions: bridge.core.functions.map((fn, index) =>
			lowerFunctionBridge(fn, bridge.source.functions[index]!),
		),
	};
}
