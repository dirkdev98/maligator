import type { CoreCompilation } from "../core/core-compilation.ts";
import { buildCoreControlFlow } from "../core/core-ir-control-flow.ts";
import { verifyCoreOptimizationPlan } from "../core/core-ir-region-validity.ts";
import type {
	CoreDirectEntryPlan,
	CorePlanRepresentation,
} from "../core/core-ir-regions.ts";
import { verifyCoreProgram } from "../core/core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreAttributeValue,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreRepresentation,
	SealedCoreProgram,
	CoreValueId,
} from "../core/core-ir.ts";
import type { CoreFunctionStore } from "../core/core-store.ts";
import { COMPILER_TWO_ADDRESS_OPERANDS } from "../shared/compiler-instruction.ts";
import type { CompilerInstruction } from "../shared/compiler-instruction.ts";
import {
	coreInstructionNeedsOperationSafepoint,
	requireCoreTargetOperationContract,
} from "./core-operation-contract.ts";
import type {
	ExecutionFunction,
	ExecutionFunctionMap,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionRegisterRepresentation,
	ExecutionSafepoint,
} from "./execution-ir.ts";
import { executionFunctionIndex } from "./execution-ir.ts";
import {
	executionLoopBackedgeInstructions,
	executionSafepointRootRegisters,
} from "./execution-liveness.ts";
import { verifyExecutionProgram } from "./verify-execution.ts";

export type {
	ExecutionFunction,
	ExecutionMove,
	ExecutionParallelCopy,
	ExecutionProgram,
	ExecutionSafepoint,
} from "./execution-ir.ts";

export interface LowerCoreToExecutionOptions {
	readonly reuseRegisters?: boolean;
}

interface LoweredParallelCopy {
	readonly moves: Array<ExecutionMove>;
	readonly temporaries: Array<number>;
}

const REGISTERLESS_CORE_OPERATIONS: ReadonlySet<string> = new Set([
	"asyncStart",
	"createPrivateNames",
	"envCopy",
	"envPop",
	"envPush",
	"generatorStart",
	"initGlobalVars",
]);

const FUNCTION_INDEX_ATTRIBUTES: ReadonlySet<string> = new Set([
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
]);

function isCoreAttributeArray(
	value: CoreAttributeValue,
): value is ReadonlyArray<CoreAttributeValue> {
	return Array.isArray(value);
}

function parallelMoves(
	assignments: ReadonlyArray<{
		readonly destination: number;
		readonly source: number;
	}>,
	nextRegister: { value: number },
	registerRepresentations: Map<number, CoreRepresentation>,
): LoweredParallelCopy {
	const pending = assignments
		.filter(({ destination, source }) => destination !== source)
		.map((assignment) => ({ ...assignment }));
	const moves: Array<ExecutionMove> = [];
	const temporaries: Array<number> = [];
	while (pending.length > 0) {
		const ready = pending.findIndex(
			({ destination }) => !pending.some(({ source }) => source === destination),
		);
		if (ready >= 0) {
			const [assignment] = pending.splice(ready, 1);
			moves.push({
				type: "move",
				registers: [assignment!.destination, assignment!.source],
			});
			continue;
		}
		const saved = pending[0]!.destination;
		const temporary = nextRegister.value++;
		const representation = registerRepresentations.get(saved);
		if (representation === undefined) {
			throw new Error(`Parallel move has no Core representation for r${saved}`);
		}
		registerRepresentations.set(temporary, representation);
		temporaries.push(temporary);
		moves.push({ type: "move", registers: [temporary, saved] });
		for (const assignment of pending) {
			if (assignment.source === saved) assignment.source = temporary;
		}
	}
	return { moves, temporaries };
}

export function physicalRegisterClass(
	representation: CoreRepresentation,
): ExecutionRegisterRepresentation {
	if (representation === "i32") return "int32";
	if (representation === "f64") return "number";
	if (representation === "boolean") return "boolean";
	return representation === "string" ? "string" : "boxed";
}

function createExecutionFunctionMap(
	compilation: CoreCompilation,
): ExecutionFunctionMap {
	const executionToCore = [...compilation.plan.liveFunctions];
	const coreToExecution = Array<number>(compilation.program.functionCapacity).fill(-1);
	for (const [execution, core] of executionToCore.entries()) {
		coreToExecution[core] = execution;
	}
	return Object.freeze({
		coreToExecution: Object.freeze(coreToExecution),
		executionToCore: Object.freeze(executionToCore),
	});
}

function relocateFunctionReferences(
	attributes: CoreInstructionAttributes,
	map: ExecutionFunctionMap,
): CoreInstructionAttributes {
	let changed = false;
	const relocated: Record<string, CoreAttributeValue> = { ...attributes };
	for (const key of FUNCTION_INDEX_ATTRIBUTES) {
		const value = attributes[key];
		if (typeof value !== "number" || value < 0) continue;
		relocated[key] = executionFunctionIndex(map, value);
		changed = true;
	}
	const guarded = attributes.guardedFunctionIndices;
	if (isCoreAttributeArray(guarded)) {
		relocated.guardedFunctionIndices = guarded.map((value) =>
			typeof value === "number" ? executionFunctionIndex(map, value) : value,
		);
		changed = true;
	}
	return changed ? relocated : attributes;
}

function sourcePositionMarker(position: number | undefined): Array<CompilerInstruction> {
	return position === undefined ? [] : [{ type: "sourcePos", pos: position }];
}

function lowerCoreImmediate(
	value: CoreImmediate,
	destination: number,
): CompilerInstruction {
	switch (value.kind) {
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "boolean":
			return { type: "createBoolean", registers: [destination], value: value.value };
		case "number":
			return { type: "createNumber", registers: [destination], value: value.value };
		case "string":
			return { type: "createString", registers: [destination], stringIndex: value.index };
	}
}

function rebuildOperation(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	registerForValue: (value: CoreValueId) => number,
	functionMap: ExecutionFunctionMap,
	directEntryId: number | undefined,
): CompilerInstruction {
	const opcode = fn.instructionOpcodeName(instruction);
	const contract = requireCoreTargetOperationContract(opcode);
	const attributes = relocateFunctionReferences(
		{
			...fn.instructionAttributes(instruction),
			...(directEntryId === undefined ? {} : { directEntryId }),
		},
		functionMap,
	);
	const registers = [
		...fn.instructionResults(instruction),
		...fn.instructionOperands(instruction),
	].map(registerForValue);
	return {
		type: contract.targetType,
		...attributes,
		...(REGISTERLESS_CORE_OPERATIONS.has(opcode) ? {} : { registers }),
	} as CompilerInstruction;
}

function lowerFunctionToTarget(
	program: SealedCoreProgram,
	coreFunction: CoreFunctionStore,
	executionFunction: number,
	functionMap: ExecutionFunctionMap,
	directEntryIds: ReadonlyMap<CoreInstructionId, number>,
	directEntryPlans: ReadonlyArray<CoreDirectEntryPlan>,
): ExecutionFunction {
	const control = buildCoreControlFlow(program, coreFunction.id, { exceptions: true });
	const blockOrder = [...control.reversePostorder];
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	const blocks: Array<{ instructions: Array<CompilerInstruction> }> = blockOrder.map(
		() => ({ instructions: [] }),
	);

	const registerRepresentations = new Map<number, CoreRepresentation>();
	const registersByValue = new Int32Array(coreFunction.valueCapacity);
	registersByValue.fill(-1);
	let nextBaseRegister = 0;
	const allocateValue = (value: CoreValueId): void => {
		if (registersByValue[value]! >= 0) return;
		const register = nextBaseRegister++;
		registersByValue[value] = register;
		registerRepresentations.set(register, coreFunction.valueRepresentation(value));
	};
	for (const parameter of coreFunction.parameters) allocateValue(parameter);
	for (let value = 0; value < coreFunction.valueCapacity; value++) {
		if (coreFunction.isValueLive(value as CoreValueId)) allocateValue(value as CoreValueId);
	}
	const allocatedRegisterCount = nextBaseRegister;
	const nextRegister = { value: nextBaseRegister };
	const registerForValue = (value: CoreValueId): number => {
		const register = registersByValue[value]!;
		if (register < 0) throw new Error(`Core value %${value} has no execution register`);
		return register;
	};

	const parallelCopies: Array<ExecutionParallelCopy> = [];
	const temporaryRegisters: Array<number> = [];
	const edgeBlock = (edge: CoreEdge): number => {
		const targetBlock = loweredBlockForCore.get(edge.block);
		if (targetBlock === undefined) {
			throw new Error(`Core edge targets unreachable block b${edge.block}`);
		}
		const parameters = coreFunction.blockParameters(edge.block);
		if (parameters[0]?.role === "exception") {
			throw new Error(`Ordinary Core edge targets exception block b${edge.block}`);
		}
		const assignments = parameters.map((parameter, index) => ({
			destination: registerForValue(parameter.value),
			source: registerForValue(edge.arguments[index]!),
		}));
		const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
		if (copy.moves.length === 0) return targetBlock;
		parallelCopies.push({ kind: "edge", assignments, ...copy });
		temporaryRegisters.push(...copy.temporaries);
		const block = blocks.length;
		blocks.push({
			instructions: [...copy.moves, { type: "jump", blocks: [targetBlock] }],
		});
		return block;
	};

	const pendingOperationSafepoints: Array<
		Omit<Extract<ExecutionSafepoint, { kind: "operation" }>, "rootRegisters">
	> = [];
	for (const blockId of blockOrder) {
		const loweredBlock = loweredBlockForCore.get(blockId)!;
		const instructions = blocks[loweredBlock]!.instructions;
		const handler = coreFunction.blockHandler(blockId);
		if (handler !== undefined) {
			const targetBlock = loweredBlockForCore.get(handler.block);
			if (targetBlock === undefined) {
				throw new Error(`Core handler targets unreachable block b${handler.block}`);
			}
			const parameters = coreFunction.blockParameters(handler.block);
			if (parameters[0]?.role !== "exception") {
				throw new Error(`Core handler b${handler.block} has no exception parameter`);
			}
			instructions.push({ type: "tryBegin", blocks: [targetBlock, loweredBlock] });
			const assignments = parameters.slice(1).map((parameter, index) => ({
				destination: registerForValue(parameter.value),
				source: registerForValue(handler.arguments[index]!),
			}));
			const copy = parallelMoves(assignments, nextRegister, registerRepresentations);
			if (copy.moves.length > 0) {
				parallelCopies.push({ kind: "handler-input", assignments, ...copy });
				temporaryRegisters.push(...copy.temporaries);
			}
			instructions.push(...copy.moves);
		}
		const parameters = coreFunction.blockParameters(blockId);
		if (parameters[0]?.role === "exception") {
			instructions.push({
				type: "catch",
				registers: [registerForValue(parameters[0].value)],
			});
		}

		for (const instruction of coreFunction.bodyInstructionIds(blockId)) {
			instructions.push(
				...sourcePositionMarker(coreFunction.instructionSourcePosition(instruction)),
			);
			const lowered = rebuildOperation(
				coreFunction,
				instruction,
				registerForValue,
				functionMap,
				directEntryIds.get(instruction),
			);
			let resultMove: CompilerInstruction | undefined;
			const twoAddress = COMPILER_TWO_ADDRESS_OPERANDS[lowered.type];
			if (twoAddress !== undefined) {
				const registers = (lowered as { readonly registers: Array<number> }).registers;
				const destination = registers[twoAddress.result]!;
				const operand = registers[twoAddress.operand]!;
				if (destination !== operand) {
					const constrained = nextRegister.value++;
					registerRepresentations.set(constrained, "boxed");
					temporaryRegisters.push(constrained);
					instructions.push({ type: "move", registers: [constrained, operand] });
					registers[twoAddress.result] = constrained;
					registers[twoAddress.operand] = constrained;
					resultMove = { type: "move", registers: [destination, constrained] };
				}
			}
			instructions.push(lowered);
			if (resultMove !== undefined) instructions.push(resultMove);
			if (coreInstructionNeedsOperationSafepoint(coreFunction, instruction)) {
				pendingOperationSafepoints.push({
					kind: "operation",
					coreInstruction: instruction,
					realizedCoreInstructions: [instruction],
					instruction: lowered,
				});
			}
		}

		const terminatorId = coreFunction.blockTerminator(blockId);
		const terminator = coreFunction.terminatorPayload(terminatorId);
		instructions.push(
			...sourcePositionMarker(coreFunction.instructionSourcePosition(terminatorId)),
		);
		switch (terminator.kind) {
			case "jump":
				instructions.push({ type: "jump", blocks: [edgeBlock(terminator.edge)] });
				break;
			case "branch":
				instructions.push(
					{
						type: "jumpIf",
						registers: [registerForValue(terminator.condition)],
						blocks: [edgeBlock(terminator.consequent)],
					},
					{ type: "jump", blocks: [edgeBlock(terminator.alternate)] },
				);
				break;
			case "guard":
				instructions.push(
					{
						type: "jumpIf",
						registers: [registerForValue(terminator.condition)],
						blocks: [edgeBlock(terminator.success)],
					},
					{ type: "jump", blocks: [edgeBlock(terminator.fallback)] },
				);
				break;
			case "return":
			case "throw":
				instructions.push({
					type: terminator.kind,
					registers: [registerForValue(terminator.value)],
				});
				break;
			case "switch":
				for (const switchCase of terminator.cases) {
					const immediate = nextRegister.value++;
					const matches = nextRegister.value++;
					temporaryRegisters.push(immediate, matches);
					registerRepresentations.set(
						immediate,
						switchCase.value.kind === "number"
							? "f64"
							: switchCase.value.kind === "boolean"
								? "boolean"
								: "boxed",
					);
					registerRepresentations.set(matches, "boolean");
					instructions.push(
						lowerCoreImmediate(switchCase.value, immediate),
						{
							type: "binary",
							registers: [
								matches,
								registerForValue(terminator.discriminant),
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
					blocks: [edgeBlock(terminator.default)],
				});
				break;
			case "unreachable":
				throw new Error(`Reachable Core block b${blockId} ends in unreachable`);
		}
		if (handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	const physicalRepresentations = Array.from(
		{ length: nextRegister.value },
		(_, register): ExecutionRegisterRepresentation => {
			const representation = registerRepresentations.get(register);
			if (representation === undefined) {
				throw new Error(`Execution register r${register} has no representation`);
			}
			return coreFunction.isGenerator || coreFunction.isAsync
				? "boxed"
				: physicalRegisterClass(representation);
		},
	);
	const fnWithoutGc: Omit<ExecutionFunction, "gc"> = {
		sourcePath: coreFunction.metadata.sourcePath,
		functionIndex: executionFunction,
		nameStringIndex: coreFunction.metadata.nameStringIndex,
		blocks,
		specializations: [],
		isGenerator: coreFunction.isGenerator,
		isAsync: coreFunction.isAsync,
		parameterCount: coreFunction.parameters.length,
		mappedArgumentSlots: [...coreFunction.metadata.mappedArgumentSlots],
		mappedArguments: coreFunction.metadata.mappedArguments,
		length: coreFunction.metadata.length,
		registerCount: nextRegister.value,
		allocatedRegisterCount,
		registerRepresentations: physicalRepresentations,
		directEntries: [],
		capturedCount: coreFunction.metadata.capturedCount,
		strict: coreFunction.metadata.strict,
		isClassConstructor: coreFunction.metadata.isClassConstructor,
		isDerivedConstructor: coreFunction.metadata.isDerivedConstructor,
		hasPrototype: coreFunction.metadata.hasPrototype,
		parallelCopies,
		temporaryRegisters,
	};
	const analysisFunction: ExecutionFunction = {
		...fnWithoutGc,
		gc: { safepoints: [] },
	};
	const pendingSafepoints = [
		...pendingOperationSafepoints,
		...[...executionLoopBackedgeInstructions(analysisFunction)].map((instruction) => ({
			kind: "loop-backedge" as const,
			instruction,
		})),
	];
	const roots = executionSafepointRootRegisters(
		analysisFunction,
		new Set(pendingSafepoints.map(({ instruction }) => instruction)),
	);
	const instructionOrder = new Map<CompilerInstruction, number>();
	let order = 0;
	for (const block of blocks) {
		for (const instruction of block.instructions) instructionOrder.set(instruction, order++);
	}
	const safepoints: Array<ExecutionSafepoint> = pendingSafepoints
		.map((safepoint) => ({
			...safepoint,
			rootRegisters: roots.get(safepoint.instruction) ?? [],
		}))
		.sort(
			(left, right) =>
				instructionOrder.get(left.instruction)! -
				instructionOrder.get(right.instruction)!,
		);
	const directEntries = directEntryPlans.map((entry) => ({
		id: entry.id,
		parameterRepresentations: entry.parameterRepresentations.map(
			planExecutionRepresentation,
		),
		resultRepresentation: planExecutionRepresentation(entry.resultRepresentation),
		registerRepresentations: physicalRepresentations,
		gc: { safepoints },
	}));
	return { ...fnWithoutGc, directEntries, gc: { safepoints } };
}

function planExecutionRepresentation(
	representation: CorePlanRepresentation,
): ExecutionRegisterRepresentation {
	if (representation === "f64") return "number";
	if (representation === "i32") return "int32";
	return representation;
}

/** Lower sealed Core directly into the generic runtime execution contract. */
export function lowerCoreCompilationToExecutionProgram(
	compilation: CoreCompilation,
	_options: LowerCoreToExecutionOptions = {},
): ExecutionProgram {
	verifyCoreProgram(
		compilation.program,
		{ stage: "pre-target" },
		compilation.context,
	);
	verifyCoreOptimizationPlan(compilation.program, compilation.plan);
	const functionMap = createExecutionFunctionMap(compilation);
	const directEntryPlans = new Map<number, Array<CoreDirectEntryPlan>>();
	const directEntryIds = new Map<number, Map<CoreInstructionId, number>>();
	for (const entry of compilation.plan.directEntries) {
		const entries = directEntryPlans.get(entry.function) ?? [];
		entries.push(entry);
		directEntryPlans.set(entry.function, entries);
		for (const site of entry.callSites) {
			const calls = directEntryIds.get(site.caller) ??
				new Map<CoreInstructionId, number>();
			calls.set(site.instruction, entry.id);
			directEntryIds.set(site.caller, calls);
		}
	}
	const functions = functionMap.executionToCore.map((core, execution) =>
		lowerFunctionToTarget(
			compilation.program,
			compilation.program.function(core),
			execution,
			functionMap,
			directEntryIds.get(core) ?? new Map(),
			directEntryPlans.get(core) ?? [],
		),
	);
	return Object.freeze({
		core: compilation.program,
		context: compilation.context,
		functionMap,
		functions: Object.freeze(functions),
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
