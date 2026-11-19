import type { CoreCompilation } from "../core/core-compilation.ts";
import type { CorePlanRepresentation } from "../core/core-ir-regions.ts";
import type { CoreBlockId, CoreRepresentation, CoreValueId } from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type {
	CoreStorageAssignment,
	CoreTargetPreparation,
	LowerCoreToCoreTargetOptions,
} from "./lower-core-target.ts";
import { lowerCoreCompilationToTargetProgram } from "./lower-core-target.ts";
import { verifyExecutionProgram } from "./verify-execution.ts";

export { coreSupportsDirectEntries, physicalRegisterClass } from "./lower-core-target.ts";
export type {
	ExecutionFunction,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionSafepoint,
} from "./execution-ir.ts";
export interface LowerCoreToExecutionOptions {
	readonly preparation?: CoreTargetPreparation;
	readonly reuseRegisters?: boolean;
	readonly excludeGuardedDirectCalls?: boolean;
	readonly mappedFunctionArrayCallHints?: LowerCoreToCoreTargetOptions["mappedFunctionArrayCallHints"];
}
export function lowerCoreCompilationToExecutionProgram(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	return lowerCoreCompilationToTargetProgram(compilation, {
		...options,
		assignStorage: (fn, blocks, reserved, variants) =>
			coreRegisterClasses(
				fn,
				options.reuseRegisters !== false,
				reserved,
				blocks,
				variants,
			),
	});
}
export function lowerCoreCompilationToRuntimeExecution(
	compilation: CoreCompilation,
	options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	const program = lowerCoreCompilationToExecutionProgram(compilation, options);
	verifyExecutionProgram(program);
	return program;
}

export function coreRegisterClasses(
	fn: CoreFunctionStore,
	reuseRegisters = true,
	reservedAbiColors: ReadonlySet<number> = new Set(),
	blockOrder: ReadonlyArray<CoreBlockId> = [...fn.blockIds()],
	variantRepresentations: ReadonlyArray<ReadonlyArray<CorePlanRepresentation>> = [],
): CoreStorageAssignment {
	const kernel = fn.kernel;
	const included = new Set(blockOrder);
	const uses = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const definitions = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const successors = new Array<Set<CoreBlockId>>(fn.blockCapacity);
	const predecessors = new Array<Array<CoreBlockId>>(fn.blockCapacity);
	const terminatorValues = new Array<ReadonlyArray<CoreValueId>>(fn.blockCapacity);
	const handlerParameters = (block: CoreBlockId): ReadonlyArray<CoreValueId> => {
		const handler = kernel.blockHandlerBlock(block);
		if (handler === undefined || !included.has(handler)) return [];
		const parameterStart = kernel.blockParameterStart(handler);
		const parameterCount = kernel.blockParameterCount(handler);
		if (parameterCount === 0 || kernel.blockParameterRole(parameterStart) !== 1) {
			throw new Error(`Core handler b${handler} has no exception parameter`);
		}
		const explicitCount = parameterCount - 1;
		const argumentCount = kernel.blockHandlerArgumentCount(block);
		if (explicitCount !== argumentCount) {
			throw new Error(
				`Core handler b${handler} expects ${explicitCount} explicit arguments, received ${argumentCount}`,
			);
		}
		const explicit = new Array<CoreValueId>(explicitCount);
		for (let index = 0; index < explicitCount; index++) {
			explicit[index] = kernel.blockParameterValue(parameterStart + index + 1);
		}
		return explicit;
	};
	for (const block of blockOrder) {
		uses[block] = new Set();
		definitions[block] = new Set();
		successors[block] = new Set();
		predecessors[block] = [];
	}
	for (const block of blockOrder) {
		const blockUses = uses[block]!;
		const blockDefinitions = definitions[block]!;
		const parameterStart = kernel.blockParameterStart(block);
		const parameterCount = kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			blockDefinitions.add(kernel.blockParameterValue(parameterStart + index));
		}
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of fn.bodyInstructionIds(block)) {
			const operandStart = kernel.instructionOperandStart(instruction);
			const operandCount = kernel.instructionOperandCount(instruction);
			for (let index = 0; index < operandCount; index++) {
				addUse(kernel.operandAt(operandStart + index));
			}
			const resultStart = kernel.instructionResultStart(instruction);
			const resultCount = kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				blockDefinitions.add(kernel.resultAt(resultStart + index));
			}
		}
		const terminator = fn.blockTerminator(block);
		const terminatorOperandStart = kernel.instructionOperandStart(terminator);
		const terminatorOperandCount = kernel.instructionOperandCount(terminator);
		const values = new Array<CoreValueId>(terminatorOperandCount);
		for (let index = 0; index < terminatorOperandCount; index++) {
			values[index] = kernel.operandAt(terminatorOperandStart + index);
		}
		terminatorValues[block] = values;
		for (const value of values) addUse(value);
		const handlerArgumentStart = kernel.blockHandlerArgumentStart(block);
		const handlerArgumentCount = kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerArgumentCount; index++) {
			addUse(kernel.handlerArgumentAt(handlerArgumentStart + index));
		}
		const edgeStart = kernel.terminatorEdgeStart(terminator);
		const edgeCount = kernel.terminatorEdgeCount(terminator);
		for (let index = 0; index < edgeCount; index++) {
			const target = kernel.terminatorEdgeBlock(edgeStart + index);
			if (included.has(target)) successors[block]!.add(target);
		}
		const handler = kernel.blockHandlerBlock(block);
		if (handler !== undefined && included.has(handler)) {
			successors[block]!.add(handler);
		}
	}
	for (const block of blockOrder) {
		for (const successor of successors[block]!) predecessors[successor]!.push(block);
	}
	const liveIn = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const liveOut = new Array<Set<CoreValueId>>(fn.blockCapacity);
	const liveInOrder = new Array<Array<CoreValueId>>(fn.blockCapacity);
	for (const block of blockOrder) {
		liveIn[block] = new Set(uses[block]);
		liveOut[block] = new Set();
		liveInOrder[block] = [...liveIn[block]];
	}
	const pending = [...blockOrder];
	const queued = new Uint8Array(fn.blockCapacity);
	for (const block of blockOrder) queued[block] = 1;
	const propagated = new Uint32Array(fn.blockCapacity);
	while (pending.length > 0) {
		const block = pending.pop()!;
		queued[block] = 0;
		const order = liveInOrder[block]!;
		const start = propagated[block]!;
		propagated[block] = order.length;
		for (const predecessor of predecessors[block]!) {
			let changed = false;
			for (let index = start; index < order.length; index++) {
				const value = order[index]!;
				liveOut[predecessor]!.add(value);
				if (definitions[predecessor]!.has(value) || liveIn[predecessor]!.has(value)) {
					continue;
				}
				liveIn[predecessor]!.add(value);
				liveInOrder[predecessor]!.push(value);
				changed = true;
			}
			if (changed && queued[predecessor] === 0) {
				queued[predecessor] = 1;
				pending.push(predecessor);
			}
		}
	}

	interface RegisterRange {
		readonly block: CoreBlockId;
		start: number;
		end: number;
	}
	interface LiveInterval {
		readonly value: CoreValueId;
		readonly firstRange: RegisterRange;
		lastRange: RegisterRange;
		laterRanges: Array<RegisterRange> | undefined;
	}
	const intervals = new Array<LiveInterval | undefined>(fn.valueCapacity);
	const touch = (value: CoreValueId, block: CoreBlockId, position: number): void => {
		let interval = intervals[value];
		if (interval === undefined) {
			const range = { block, start: position, end: position };
			interval = {
				value,
				firstRange: range,
				lastRange: range,
				laterRanges: undefined,
			};
			intervals[value] = interval;
		} else if (interval.lastRange.block !== block) {
			const range = { block, start: position, end: position };
			(interval.laterRanges ??= []).push(range);
			interval.lastRange = range;
		} else {
			const range = interval.lastRange;
			range.start = Math.min(range.start, position);
			range.end = Math.max(range.end, position);
		}
	};
	// Each block contributes one range per value on a disjoint position span.
	const shapeCaseValues = new Set<CoreValueId>();
	const selectShapeCase = fn.registry.get("selectShapeCase")?.id;
	let nextPosition = 0;
	for (const block of blockOrder) {
		const blockStart = nextPosition++;
		const parameterStart = kernel.blockParameterStart(block);
		const parameterCount = kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			touch(kernel.blockParameterValue(parameterStart + index), block, blockStart);
		}
		for (const value of liveIn[block]!) touch(value, block, blockStart);
		for (const instruction of fn.bodyInstructionIds(block)) {
			const readPosition = nextPosition++;
			const writePosition = nextPosition++;
			const operandStart = kernel.instructionOperandStart(instruction);
			const operandCount = kernel.instructionOperandCount(instruction);
			for (let index = 0; index < operandCount; index++) {
				touch(kernel.operandAt(operandStart + index), block, readPosition);
			}
			const resultStart = kernel.instructionResultStart(instruction);
			const resultCount = kernel.instructionResultCount(instruction);
			const unique = kernel.instructionOpcode(instruction) === selectShapeCase;
			for (let index = 0; index < resultCount; index++) {
				const value = kernel.resultAt(resultStart + index);
				touch(value, block, writePosition);
				if (unique) shapeCaseValues.add(value);
			}
		}
		const blockEnd = nextPosition++;
		for (const value of terminatorValues[block]!) touch(value, block, blockEnd);
		const handlerArgumentStart = kernel.blockHandlerArgumentStart(block);
		const handlerArgumentCount = kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerArgumentCount; index++) {
			touch(kernel.handlerArgumentAt(handlerArgumentStart + index), block, blockEnd);
		}
		for (const value of liveOut[block]!) touch(value, block, blockEnd);
		for (const parameter of handlerParameters(block)) {
			touch(parameter, block, blockStart);
			touch(parameter, block, blockEnd);
		}
	}

	const roots = new Map<CoreValueId, CoreValueId>();
	const liveIntervals = intervals.filter(
		(interval): interval is LiveInterval => interval !== undefined,
	);
	for (const interval of liveIntervals) roots.set(interval.value, interval.value);
	const abi = new Map<CoreValueId, number>();
	for (let index = 0; index < fn.parameterCount; index++) {
		abi.set(kernel.functionParameter(index), index);
	}
	let snapshotIndex = 0;
	for (const instruction of fn.bodyInstructionIds(fn.entry)) {
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode !== "loadArgumentCount" && opcode !== "loadArgument") break;
		if (kernel.instructionResultCount(instruction) === 0) continue;
		const output = kernel.resultAt(kernel.instructionResultStart(instruction));
		abi.set(output, fn.parameterCount + snapshotIndex++);
	}
	interface RegisterColor {
		readonly register: number;
		readonly rangesByBlock: Map<CoreBlockId, Array<RegisterRange>>;
		lastEnd: number;
	}
	const registers = new Map<CoreValueId, number>();
	const registerRepresentations = new Map<number, CoreRepresentation>();
	const colorClasses = new Map<string, Array<RegisterColor>>();
	const colorClass = (value: CoreValueId, representation: CoreRepresentation): string =>
		variantRepresentations.length === 0
			? representation
			: `${representation}:${variantRepresentations.map((representations) => representations[value]).join(",")}`;
	// Assigned ranges in a block are disjoint. The last range starting before
	// the query ends is its only possible overlap.
	const upperBound = (ranges: ReadonlyArray<RegisterRange>, position: number): number => {
		let low = 0;
		let high = ranges.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (ranges[middle]!.start <= position) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	const rangeOverlaps = (color: RegisterColor, range: RegisterRange): boolean => {
		const ranges = color.rangesByBlock.get(range.block);
		if (ranges === undefined) return false;
		const next = upperBound(ranges, range.end);
		return next > 0 && ranges[next - 1]!.end >= range.start;
	};
	const overlaps = (color: RegisterColor, interval: LiveInterval): boolean => {
		if (color.lastEnd < interval.firstRange.start) return false;
		if (rangeOverlaps(color, interval.firstRange)) return true;
		if (interval.laterRanges !== undefined)
			for (const range of interval.laterRanges)
				if (rangeOverlaps(color, range)) return true;
		return false;
	};
	const addRange = (color: RegisterColor, range: RegisterRange): void => {
		const ranges = color.rangesByBlock.get(range.block);
		if (ranges === undefined) {
			color.rangesByBlock.set(range.block, [range]);
		} else if (ranges[ranges.length - 1]!.end < range.start) {
			ranges.push(range);
		} else {
			ranges.splice(upperBound(ranges, range.start), 0, range);
		}
	};
	const addColor = (register: number, key: string): RegisterColor => {
		const color: RegisterColor = { register, rangesByBlock: new Map(), lastEnd: -1 };
		let candidates = colorClasses.get(key);
		if (candidates === undefined) {
			candidates = [];
			colorClasses.set(key, candidates);
		}
		if (
			candidates.length === 0 ||
			candidates[candidates.length - 1]!.register < register
		) {
			candidates.push(color);
		} else {
			let index = 0;
			while (candidates[index]!.register < register) index++;
			candidates.splice(index, 0, color);
		}
		return color;
	};
	const assign = (
		interval: LiveInterval,
		register: number,
		representation: CoreRepresentation,
		color: RegisterColor | undefined,
	): void => {
		registers.set(interval.value, register);
		registerRepresentations.set(register, representation);
		if (color !== undefined) {
			color.lastEnd = Math.max(color.lastEnd, interval.lastRange.end);
			addRange(color, interval.firstRange);
			if (interval.laterRanges !== undefined)
				for (const range of interval.laterRanges) addRange(color, range);
		}
	};
	let nextUniqueRegister = 0;
	for (const interval of liveIntervals) {
		const register = abi.get(interval.value);
		if (register === undefined) continue;
		const representation = fn.valueRepresentation(interval.value);
		const color =
			reuseRegisters && !reservedAbiColors.has(register)
				? addColor(register, colorClass(interval.value, representation))
				: undefined;
		assign(interval, register, representation, color);
		nextUniqueRegister = Math.max(nextUniqueRegister, register + 1);
	}
	// The first unused non-ABI color competes with lower compatible colors.
	let nextFreeRegister = 0;
	const ordered = [...liveIntervals].sort(
		(left, right) =>
			left.firstRange.start - right.firstRange.start ||
			left.lastRange.end - right.lastRange.end ||
			left.value - right.value,
	);
	for (const interval of ordered) {
		if (registers.has(interval.value)) continue;
		const representation = fn.valueRepresentation(interval.value);
		let register = nextUniqueRegister;
		let color: RegisterColor | undefined;
		if (reuseRegisters) {
			const key = colorClass(interval.value, representation);
			if (!shapeCaseValues.has(interval.value)) {
				while (
					reservedAbiColors.has(nextFreeRegister) ||
					registerRepresentations.has(nextFreeRegister)
				) {
					nextFreeRegister++;
				}
				register = nextFreeRegister;
				const candidates = colorClasses.get(key);
				if (candidates !== undefined)
					for (const candidate of candidates) {
						if (candidate.register >= register) break;
						if (!overlaps(candidate, interval)) {
							color = candidate;
							register = candidate.register;
							break;
						}
					}
			}
			if (color === undefined && !reservedAbiColors.has(register))
				color = addColor(register, key);
		}
		assign(interval, register, representation, color);
		nextUniqueRegister = Math.max(nextUniqueRegister, register + 1);
	}
	return { roots, registers, registerRepresentations };
}
