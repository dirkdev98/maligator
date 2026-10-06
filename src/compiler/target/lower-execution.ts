import type { CoreCompilation } from "../core/core-compilation.ts";
import type { CorePlanRepresentation } from "../core/core-ir-regions.ts";
import type { CoreBlockId, CoreRepresentation, CoreValueId } from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import type { ExecutionProgram } from "./execution-ir.ts";
import type { CoreStorageAssignment } from "./lower-core-target.ts";
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
	readonly reuseRegisters?: boolean;
	readonly excludeGuardedDirectCalls?: boolean;
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

	interface BlockRange {
		start: number;
		end: number;
	}
	interface LiveInterval {
		readonly value: CoreValueId;
		start: number;
		end: number;
		readonly firstBlock: CoreBlockId;
		readonly firstRange: BlockRange;
		additionalRanges: Map<CoreBlockId, BlockRange> | undefined;
	}
	const intervals = new Array<LiveInterval | undefined>(fn.valueCapacity);
	const touch = (
		value: CoreValueId,
		block: CoreBlockId,
		position: number,
		blockPosition: number,
	): void => {
		let interval = intervals[value];
		if (interval === undefined) {
			interval = {
				value,
				start: position,
				end: position,
				firstBlock: block,
				firstRange: { start: blockPosition, end: blockPosition },
				additionalRanges: undefined,
			};
			intervals[value] = interval;
			return;
		}
		interval.start = Math.min(interval.start, position);
		interval.end = Math.max(interval.end, position);
		const range =
			block === interval.firstBlock
				? interval.firstRange
				: interval.additionalRanges?.get(block);
		if (range === undefined) {
			(interval.additionalRanges ??= new Map()).set(block, {
				start: blockPosition,
				end: blockPosition,
			});
		} else {
			range.start = Math.min(range.start, blockPosition);
			range.end = Math.max(range.end, blockPosition);
		}
	};
	let nextPosition = 0;
	for (const block of blockOrder) {
		const blockStart = nextPosition++;
		const parameterStart = kernel.blockParameterStart(block);
		const parameterCount = kernel.blockParameterCount(block);
		for (let index = 0; index < parameterCount; index++) {
			touch(kernel.blockParameterValue(parameterStart + index), block, blockStart, 0);
		}
		for (const value of liveIn[block]!) touch(value, block, blockStart, 0);
		const instructions = [...fn.bodyInstructionIds(block)];
		for (const [instructionIndex, instruction] of instructions.entries()) {
			const readPosition = nextPosition++;
			const writePosition = nextPosition++;
			const operandStart = kernel.instructionOperandStart(instruction);
			const operandCount = kernel.instructionOperandCount(instruction);
			for (let index = 0; index < operandCount; index++) {
				touch(
					kernel.operandAt(operandStart + index),
					block,
					readPosition,
					instructionIndex * 2 + 1,
				);
			}
			const resultStart = kernel.instructionResultStart(instruction);
			const resultCount = kernel.instructionResultCount(instruction);
			for (let index = 0; index < resultCount; index++) {
				touch(
					kernel.resultAt(resultStart + index),
					block,
					writePosition,
					instructionIndex * 2 + 2,
				);
			}
		}
		const blockEnd = nextPosition++;
		const blockEndPosition = instructions.length * 2 + 1;
		for (const value of terminatorValues[block]!)
			touch(value, block, blockEnd, blockEndPosition);
		const handlerArgumentStart = kernel.blockHandlerArgumentStart(block);
		const handlerArgumentCount = kernel.blockHandlerArgumentCount(block);
		for (let index = 0; index < handlerArgumentCount; index++) {
			touch(
				kernel.handlerArgumentAt(handlerArgumentStart + index),
				block,
				blockEnd,
				blockEndPosition,
			);
		}
		for (const value of liveOut[block]!) touch(value, block, blockEnd, blockEndPosition);
		for (const parameter of handlerParameters(block)) {
			touch(parameter, block, blockStart, 0);
			touch(parameter, block, blockEnd, blockEndPosition);
		}
	}

	const roots = new Map<CoreValueId, CoreValueId>();
	const liveIntervals = intervals.filter(
		(interval): interval is LiveInterval => interval !== undefined,
	);
	for (const interval of liveIntervals) roots.set(interval.value, interval.value);
	const shapeCaseValues = new Set<CoreValueId>();
	for (const block of blockOrder) {
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (fn.instructionOpcodeName(instruction) === "selectShapeCase") {
				const resultStart = kernel.instructionResultStart(instruction);
				const resultCount = kernel.instructionResultCount(instruction);
				for (let index = 0; index < resultCount; index++) {
					shapeCaseValues.add(kernel.resultAt(resultStart + index));
				}
			}
		}
	}
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
	const registers = new Map<CoreValueId, number>();
	const registerRepresentations = new Map<number, CoreRepresentation>();
	const variantClasses = new Map<number, string>();
	const variantClass = (value: CoreValueId): string =>
		variantRepresentations.map((representations) => representations[value]).join(",");
	const rangesByRegister = new Map<number, Map<CoreBlockId, Array<BlockRange>>>();
	const addRange = (
		byBlock: Map<CoreBlockId, Array<BlockRange>>,
		block: CoreBlockId,
		range: BlockRange,
	): void => {
		const ranges = byBlock.get(block) ?? [];
		let low = 0;
		let high = ranges.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (ranges[middle]!.start <= range.start) low = middle + 1;
			else high = middle;
		}
		ranges.splice(low, 0, range);
		byBlock.set(block, ranges);
	};
	const addRanges = (register: number, interval: LiveInterval): void => {
		const byBlock =
			rangesByRegister.get(register) ?? new Map<CoreBlockId, Array<BlockRange>>();
		addRange(byBlock, interval.firstBlock, interval.firstRange);
		if (interval.additionalRanges !== undefined)
			for (const [block, range] of interval.additionalRanges)
				addRange(byBlock, block, range);
		rangesByRegister.set(register, byBlock);
	};
	const blockRangeOverlaps = (
		byBlock: ReadonlyMap<CoreBlockId, ReadonlyArray<BlockRange>>,
		block: CoreBlockId,
		range: BlockRange,
	): boolean => {
		const candidates = byBlock.get(block);
		if (candidates === undefined) return false;
		for (const candidate of candidates) {
			if (candidate.start > range.end) break;
			if (range.start <= candidate.end) return true;
		}
		return false;
	};
	const overlaps = (register: number, interval: LiveInterval): boolean => {
		const byBlock = rangesByRegister.get(register);
		if (byBlock === undefined) return false;
		if (blockRangeOverlaps(byBlock, interval.firstBlock, interval.firstRange))
			return true;
		if (interval.additionalRanges !== undefined)
			for (const [block, range] of interval.additionalRanges)
				if (blockRangeOverlaps(byBlock, block, range)) return true;
		return false;
	};
	const assign = (interval: LiveInterval, register: number, variantKey: string): void => {
		registers.set(interval.value, register);
		registerRepresentations.set(register, fn.valueRepresentation(interval.value));
		variantClasses.set(register, variantKey);
		addRanges(register, interval);
	};
	for (const interval of liveIntervals) {
		const register = abi.get(interval.value);
		if (register !== undefined) assign(interval, register, variantClass(interval.value));
	}
	let nextUniqueRegister = Math.max(-1, ...registers.values()) + 1;
	const ordered = [...liveIntervals].sort(
		(left, right) =>
			left.start - right.start || left.end - right.end || left.value - right.value,
	);
	for (const interval of ordered) {
		if (registers.has(interval.value)) continue;
		const representation = fn.valueRepresentation(interval.value);
		const variantKey = variantClass(interval.value);
		let register = nextUniqueRegister;
		if (reuseRegisters && !shapeCaseValues.has(interval.value)) {
			register = 0;
			while (
				reservedAbiColors.has(register) ||
				(registerRepresentations.has(register) &&
					registerRepresentations.get(register) !== representation) ||
				(variantClasses.has(register) && variantClasses.get(register) !== variantKey) ||
				overlaps(register, interval)
			) {
				register++;
			}
		}
		assign(interval, register, variantKey);
		nextUniqueRegister = Math.max(nextUniqueRegister, register + 1);
	}
	return { roots, registers, registerRepresentations };
}
